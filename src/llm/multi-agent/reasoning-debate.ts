import { BaseLLM } from '#llm/base-llm';
import { getLLM } from '#llm/llmFactory';
import { FastMediumLLM } from '#llm/multi-agent/fastMedium';
import { anthropicClaude4_5_Sonnet } from '#llm/services/anthropic';
import { Claude4_5_Opus_Vertex, Claude4_5_Sonnet_Vertex } from '#llm/services/anthropic-vertex';
import { openaiGPT5 } from '#llm/services/openai';
import { vertexGemini_2_5_Pro } from '#llm/services/vertexai';
import { xai_Grok4 } from '#llm/services/xai';
import { logger } from '#o11y/logger';
import {
	type AssistantContentExt,
	type GenerateTextOptions,
	type GenerationStats,
	type LLM,
	type LlmMessage,
	lastText,
	messageText,
} from '#shared/llm/llm.model';

// Helper function to initialize GenerationStats
function createEmptyStats(llmId: string): GenerationStats {
	return {
		requestTime: 0,
		timeToFirstToken: 0,
		totalTime: 0,
		inputTokens: 0,
		outputTokens: 0,
		cost: 0,
		llmId: llmId,
		cachedInputTokens: 0,
	};
}

// Helper function to add stats from one GenerationStats object to an accumulator
function accumulateStats(accumulator: GenerationStats, newStats?: GenerationStats): void {
	if (!newStats) return;

	accumulator.requestTime += newStats.requestTime || 0;
	accumulator.timeToFirstToken += newStats.timeToFirstToken || 0; // Summing timeToFirstToken as per generic "sum" request
	accumulator.totalTime += newStats.totalTime || 0;
	accumulator.inputTokens += newStats.inputTokens || 0;
	accumulator.outputTokens += newStats.outputTokens || 0;
	accumulator.cachedInputTokens = (accumulator.cachedInputTokens || 0) + (newStats.cachedInputTokens || 0);
	accumulator.cost = (accumulator.cost || 0) + (newStats.cost || 0); // Treats null cost as 0 for summation
	// accumulator.llmId remains the ID of the composite LLM.
}

// sparse multi-agent debate https://arxiv.org/abs/2406.11776

const INITIAL_TEMP = 0.7;
const DEBATE_TEMP = 0.5;
const FINAL_TEMP = 0.3;

/**
 * Multi-agent debate (spare communication topology) implementation with simple prompts for reasoning LLMs
 * @constructor
 */
export class ReasonerDebateLLM extends BaseLLM {
	llms!: LLM[];
	mediator!: LLM;

	/**
	 *
	 * @param modelIds LLM model ids to use separated by the pipe character. The first id will be used as the mediator. The remaining will be used as the initial response/debate generation.
	 * @param providedMediator
	 * @param providedDebateLLMs
	 * @param name
	 */
	constructor(modelIds = '', providedMediator?: () => LLM, providedDebateLLMs?: Array<() => LLM>, name?: string) {
		super({
			displayName: name ?? '(MoA)',
			service: 'MAD',
			modelId: modelIds,
			maxInputTokens: 200_000,
			calculateCosts: () => ({ inputCost: 0, outputCost: 0, totalCost: 0 }),
		});
		if (providedMediator) this.mediator = providedMediator();
		if (providedDebateLLMs) {
			this.llms = providedDebateLLMs.map((factory) => factory());
			// this.model = this.llms.map((llm) => llm.)
		}
		if (modelIds?.includes('|')) {
			try {
				const parts = modelIds.split('|');
				if (parts.length > 1) {
					// Set the mediator
					this.mediator = getLLM(parts[0]!);

					// Set the LLMs
					this.llms = parts.slice(1).map((llmId) => getLLM(llmId));
				} else {
					throw new Error();
				}
			} catch (e) {
				throw new Error(`Invalid model string format for MoA ${modelIds}`);
			}
		}
	}

	override isConfigured(): boolean {
		for (const llm of this.llms) {
			if (!llm.isConfigured()) return false;
		}
		return this.mediator.isConfigured();
	}

	override getModel(): string {
		return `${this.mediator.getId()}|${this.llms.map((llm) => llm.getId()).join('|')}`;
	}

	protected override supportsGenerateTextFromMessages(): boolean {
		return true;
	}

	protected override async _generateMessage(llmMessages: LlmMessage[], opts?: GenerateTextOptions): Promise<LlmMessage> {
		opts ??= {};
		// Use 'thinking' as the number of debate rounds
		let rounds = 0;
		if (opts.thinking === 'high') rounds = 3;
		else if (opts.thinking === 'medium') rounds = 2;
		else if (opts.thinking === 'low') rounds = 1;

		// We want the actuall LLM calls to use high thinking
		opts.thinking = 'high';

		const readOnlyMessages = llmMessages as ReadonlyArray<Readonly<LlmMessage>>;
		const totalStats: GenerationStats = createEmptyStats(this.getId());

		logger.info('Generating initial responses');
		const initialResponseMessages = await this.generateInitialResponses(readOnlyMessages, opts);
		initialResponseMessages.forEach((msg) => accumulateStats(totalStats, msg.stats));

		logger.info('Debating responses');
		const debatedResponseMessages = await this.multiAgentDebate(readOnlyMessages, initialResponseMessages, opts, rounds);
		debatedResponseMessages.forEach((msg) => accumulateStats(totalStats, msg.stats));

		logger.info('Mediating response');
		const finalMergedMessage = await this.mergeBestResponses(readOnlyMessages, debatedResponseMessages, opts);
		accumulateStats(totalStats, finalMergedMessage.stats);

		return {
			role: 'assistant',
			content: finalMergedMessage.content as AssistantContentExt,
			stats: totalStats,
		};
	}

	private async generateInitialResponses(llmMessages: ReadonlyArray<Readonly<LlmMessage>>, opts: GenerateTextOptions): Promise<LlmMessage[]> {
		return Promise.all(
			this.llms.map((llm) => llm.generateMessage(llmMessages, { ...opts, id: `${opts.id} - initial`, temperature: INITIAL_TEMP, thinking: 'high' })),
		);
	}

	private async multiAgentDebate(
		llmMessages: ReadonlyArray<Readonly<LlmMessage>>,
		initialMessages: ReadonlyArray<LlmMessage>, // Changed from responses: string[]
		opts: GenerateTextOptions,
		rounds: number,
	): Promise<LlmMessage[]> {
		const effectiveOpts = { ...opts, temperature: DEBATE_TEMP };
		let currentRoundMessages: ReadonlyArray<LlmMessage> = initialMessages;
		const userMessageContent = lastText(llmMessages); // Original user message text

		for (let round = 1; round <= rounds; round++) {
			// Adjusted loop to run `rounds` times for debate
			logger.info(`Debate Round ${round}...`);
			const nextRoundMessagePromises = this.llms.map((llm, index) => {
				const ownInitialResponseText = messageText(initialMessages[index]!); // Agent's own initial response
				const leftNeighborResponseText = messageText(currentRoundMessages[(index - 1 + this.llms.length) % this.llms.length]!);
				const rightNeighborResponseText = messageText(currentRoundMessages[(index + 1) % this.llms.length]!);

				const newUserPrompt = `<user-message>\n${userMessageContent}\n</user-message>\n\n<initial-response>\n${ownInitialResponseText}\n</initial-response>\n
Following are responses generated by other assistants from the previous round:\n<assistant-response-1>\n${leftNeighborResponseText}\n</assistant-response-1>\n\n<assistant-response-2>\n${rightNeighborResponseText}\n</assistant-response-2>\n
Use the insights from your initial response and the other assistants' responses to refine and update your response to the user message.
Do not mention the multiple responses provided or the debate process.
Ensure any relevant response formatting instructions from the original user message are followed.`;

				const debateMessages: LlmMessage[] = [...llmMessages]; // Copy of original messages
				debateMessages[debateMessages.length - 1] = { role: 'user', content: newUserPrompt }; // Replace last user message
				return llm.generateMessage(debateMessages, { ...effectiveOpts, id: `${opts.id} - debate round ${round}` });
			});
			currentRoundMessages = await Promise.all(nextRoundMessagePromises);
		}
		return currentRoundMessages as LlmMessage[]; // Cast because ReadonlyArray<LlmMessage>
	}

	private async mergeBestResponses(
		llmMessages: ReadonlyArray<Readonly<LlmMessage>>,
		debatedMessages: ReadonlyArray<LlmMessage>, // Changed from responses: string[]
		opts: GenerateTextOptions,
	): Promise<LlmMessage> {
		const originalUserMessageContent = lastText(llmMessages);
		const mergePrompt = `<user-message>\n${originalUserMessageContent}\n</user-message>

Following are responses generated by multiple assistants after a debate process:
${debatedMessages.map((responseMsg, index) => `<assistant-response-${index + 1}>\n${messageText(responseMsg)}\n</assistant-response-${index + 1}>`).join('\n\n')}
        
Look at the original <user-message> again. Use the insights from all the assistant responses to synthesize a final, comprehensive, and high-quality response.
Do not mention the multiple responses or the debate process.
Answer directly to the original user message and ensure any relevant response formatting instructions are followed.`;

		const mergedMessages: LlmMessage[] = [...llmMessages]; // Copy of original messages
		mergedMessages[mergedMessages.length - 1] = { role: 'user', content: mergePrompt }; // Replace last user message

		logger.info('Merging best response with mediator...');
		return this.mediator.generateMessage(mergedMessages, { ...opts, id: `${opts.id} - final`, temperature: FINAL_TEMP });
	}
}

export function MoA_reasoningLLMRegistry(): Array<() => LLM> {
	return [MAD_Fast, MAD_SOTA, MAD_Vertex, MAD_Balanced, MAD_Balanced4];
}

// export function MAD_Cost(): LLM {
// 	return new ReasonerDebateLLM(
// 		'Cost',
// 		deepinfraDeepSeekR1,
// 		[deepinfraDeepSeekR1, deepinfraDeepSeekR1, deepinfraDeepSeekR1],
// 		'MAD:Cost multi-agent debate (DeepSeek R1x3)',
// 	);
// }

export function MAD_Fast(): LLM {
	const fastMedium = new FastMediumLLM();
	const fastMediumFactory = () => fastMedium;
	return new ReasonerDebateLLM(
		'Fast',
		fastMediumFactory,
		[fastMediumFactory, fastMediumFactory, fastMediumFactory],
		'MAD:Fast multi-agent debate (Cerebras Qwen3 32b, Flash 2.5 fallback)',
	);
}

export function MAD_Balanced(): LLM {
	return new ReasonerDebateLLM(
		'Balanced',
		vertexGemini_2_5_Pro,
		[vertexGemini_2_5_Pro, xai_Grok4, openaiGPT5],
		'MAD:Balanced multi-agent debate (Gemini 2.5 Pro, Grok 4, o3)',
	);
}

export function MAD_Balanced4(): LLM {
	return new ReasonerDebateLLM(
		'Balanced4',
		vertexGemini_2_5_Pro,
		[vertexGemini_2_5_Pro, xai_Grok4, openaiGPT5, Claude4_5_Sonnet_Vertex],
		'MAD:Balanced multi-agent debate (Gemini 2.5 Pro, Grok 4, o3, Sonnet 4)',
	);
}

export function MAD_Vertex(): LLM {
	return new ReasonerDebateLLM(
		'Vertex',
		vertexGemini_2_5_Pro,
		[vertexGemini_2_5_Pro, vertexGemini_2_5_Pro, Claude4_5_Sonnet_Vertex],
		'MAD:Vertex multi-agent debate (Gemini 2.5 Pro x2, Sonnet 4)',
	);
}

export function MAD_Anthropic(): LLM {
	return new ReasonerDebateLLM(
		'Anthropic',
		anthropicClaude4_5_Sonnet,
		[anthropicClaude4_5_Sonnet, anthropicClaude4_5_Sonnet, anthropicClaude4_5_Sonnet],
		'MAD:Anthropic multi-agent debate (Sonnet 4 x3)',
	);
}

export function MAD_OpenAI(): LLM {
	return new ReasonerDebateLLM('OpenAI', openaiGPT5, [openaiGPT5, openaiGPT5, openaiGPT5], 'MAD:OpenAI multi-agent debate (GPT5 x3)');
}

export function MAD_Grok(): LLM {
	return new ReasonerDebateLLM('Grok', xai_Grok4, [xai_Grok4, xai_Grok4, xai_Grok4], 'MAD:Grok multi-agent debate (Grok 4 x3)');
}

export function MAD_SOTA(): LLM {
	return new ReasonerDebateLLM(
		'SOTA',
		openaiGPT5,
		[openaiGPT5, Claude4_5_Opus_Vertex, vertexGemini_2_5_Pro, xai_Grok4],
		'MAD:SOTA multi-agent debate (Opus 4, GPT5, Gemini 2.5 Pro, Grok 4)',
	);
}

// export function MAD_Hard(): LLM {
// 	const hardLLM = llms().hard; // cant have a dependancy to agentContextLocalStorage
// 	const hardFactory = () => hardLLM;
// 	return new ReasonerDebateLLM('Hard', hardFactory, [hardFactory, hardFactory, hardFactory], `MAD:Hard multi-agent debate (${hardLLM.getDisplayName} x3)`);
// }
