import { BaseLLM } from '#llm/base-llm';
import { getLLM } from '#llm/llmFactory';
import { cerebrasQwen3_235b_Thinking } from '#llm/services/cerebras';
import { vertexGemini_3_0_Flash } from '#llm/services/vertexai';
import { logger } from '#o11y/logger';
import type { GenerateTextOptions, LLM } from '#shared/llm/llm.model';

// sparse multi-agent debate https://arxiv.org/abs/2406.11776
// self-refine https://arxiv.org/pdf/2303.17651
// https://www.academia.edu/123745078/Mind_over_Data_Elevating_LLMs_from_Memorization_to_Cognition

export function blueberryLLMRegistry(): Array<() => LLM> {
	return [() => new Blueberry()];
}

const MIND_OVER_DATA_SYS_PROMPT = `When addressing a problem, employ "Comparative Problem Analysis and Direct Reasoning" as follows:

1. Problem Transcription:
   Reproduce the given problem verbatim, without interpretation.

2. Similar Problem Identification:
   Identify a relevant problem from your training data. Briefly state this problem and its typical solution approach.

3. Comparative Analysis:
   a) List key similarities between the given problem and the identified similar problem.
   b) Enumerate significant differences, emphasizing unique aspects of the given problem.

4. Direct Observation:
   List all explicitly stated facts and conditions in the given problem. Highlight elements that differ from the similar problem.

5. Assumption Awareness:
   a) Identify potential assumptions based on the similar problem.
   b) Explicitly state that these assumptions will not influence your reasoning.
   c) Note any implicit assumptions in the problem statement that require clarification.

6. Direct Reasoning:
   a) Based solely on the given problem's explicit information, explore possible solution paths.
   b) Explain your thought process step-by-step, ensuring independence from the similar problem's solution.
   c) If multiple approaches are viable, briefly outline each.

7. Solution Proposal:
   Present your solution(s) to the given problem, derived exclusively from your direct reasoning in step 6.

8. Verification:
   a) Cross-check your proposed solution(s) against each fact and condition from step 4.
   b) Ensure your solution doesn't contradict any given information.
   c) Verify that your solution addresses all aspects of the problem.

9. Differentiation Explanation:
   If your solution differs from that of the similar problem, explain why, referencing specific differences identified in step 3.

11. Devil's Advocate Analysis:
	a) Critically examine your proposed solution(s) from an opposing viewpoint.
	b) Identify potential flaws, weaknesses, or unintended consequences in your reasoning or solution.
	c) Present counterarguments or alternative interpretations of the problem.
	d) Challenge any assumptions made, even if they seemed reasonable initially.
	e) Consider extreme or edge cases where your solution might fail or be less effective.

12. Alternative Perspectives:
	a) Consider and state any alternative viewpoints or approaches that could lead to different solutions.
	b) Explain how these perspectives might interpret the problem differently.
	c) Briefly outline solutions that might arise from these alternative viewpoints.

13. Refinement and Synthesis:
	a) In light of the devil's advocate analysis and alternative perspectives, reassess your original solution.
	b) Refine your solution if necessary, addressing the critiques and incorporating valuable insights from alternative viewpoints.
	c) If maintaining your original solution, provide a robust defense against the counterarguments.

14. Limitations and Future Work:
	a) Acknowledge any remaining limitations in your approach, including those highlighted by the devil's advocate analysis.
	b) Suggest potential areas for further investigation or improvement.
	c) Identify any additional information or expertise that could enhance the solution.
`;

export class Blueberry extends BaseLLM {
	llms!: LLM[];
	mediator!: LLM;

	/**
	 *
	 * @param model LLM model ids to use separated by the pipe character. The first id will be used as the mediator. The remaining will be used as the initial response/debate generation.
	 */
	constructor(model = 'default') {
		super({
			displayName: 'MoA blueberry',
			service: 'MoA',
			modelId: model,
			maxInputTokens: 200_000,
			calculateCosts: () => ({ inputCost: 0, outputCost: 0, totalCost: 0 }),
		});
		if (model !== 'default') {
			try {
				const parts = model.split('|');
				if (parts.length > 1) {
					// Set the mediator
					this.mediator = getLLM(parts[0]);

					// Set the LLMs
					this.llms = parts.slice(1).map((llmId) => getLLM(llmId));
				} else {
					logger.error(`Invalid model string format for Blueberry ${model}`);
				}
			} catch (e) {
				logger.error(e, `Invalid model string format for Blueberry ${model}`);
			}
		}
		// if (!this.llms) this.llms = [Claude3_5_Sonnet_Vertex(), GPT4o(), Gemini_1_5_Pro(), Claude3_5_Sonnet_Vertex(), fireworksLlama3_405B()];
		let llm = cerebrasQwen3_235b_Thinking();
		// llm = groqLlama3_1_70B();
		llm = vertexGemini_3_0_Flash();
		if (!this.llms) this.llms = [llm, llm, llm, llm, llm];
		if (!this.mediator) this.mediator = llm;
	}

	override getModel(): string {
		return `${this.mediator.getId()}|${this.llms.map((llm) => llm.getId()).join('|')}`;
	}

	override async _generateText(systemPrompt: string | undefined, userPrompt: string, opts?: GenerateTextOptions): Promise<string> {
		if (systemPrompt) {
			logger.error('system prompt not available for Blueberry');
			// prepend to the user prompt?
		}
		logger.info('Initial response...');
		const initialResponses = await this.generateInitialResponses(userPrompt, MIND_OVER_DATA_SYS_PROMPT, opts);
		const debatedResponses = await this.multiAgentDebate(userPrompt, initialResponses, MIND_OVER_DATA_SYS_PROMPT, opts);
		logger.info('Mediating response...');
		return this.mergeBestResponses(userPrompt, debatedResponses);
	}

	private async generateInitialResponses(userPrompt: string, systemPrompt: string, opts?: GenerateTextOptions): Promise<string[]> {
		return Promise.all(this.llms.map((llm) => llm.generateText(systemPrompt, userPrompt, { ...opts, temperature: 1 })));
	}

	private async multiAgentDebate(userPrompt: string, responses: string[], systemPromptSrc: string, opts?: GenerateTextOptions, rounds = 4): Promise<string[]> {
		let debatedResponses = responses;

		for (let round = 1; round < rounds; round++) {
			logger.info(`Round ${round}...`);
			debatedResponses = await Promise.all(
				this.llms.map((llm, index) => {
					const leftNeighborIndex = (index - 1 + this.llms.length) % this.llms.length;
					const rightNeighborIndex = (index + 1) % this.llms.length;
					const newUserPrompt = `<question>\n${userPrompt}\n</question>\n\n${responses[index]}\n\nBelow are responses from two other agents:\n<response-1>\n${responses[leftNeighborIndex]}\n</response-1>\n\n<response-2>\n${responses[rightNeighborIndex]}\n</response-2>\n\nUse the insights from all the responses to refine and update your answer in the same format.`;
					return llm.generateText(systemPromptSrc, newUserPrompt, opts);
				}),
			);
		}

		return debatedResponses;
	}

	private async mergeBestResponses(userPrompt: string, responses: string[], systemPrompt?: string): Promise<string> {
		const mergePrompt = `
User's Question: ${userPrompt}

Following are responses generated by different AI models:
${responses.map((response, index) => `<response-${index + 1}>\n${response}\n</response-${index + 1}>`).join('\n\n')}
        
Task 1: Comparative Analysis
Analyze the responses, focusing on:
1. Differences in reasoning logic
2. Strengths and weaknesses of each approach
3. Potential biases, errors, or limitations in the arguments presented for a specific solution.

Task 2: Critical Evaluation
Identify and explain any issues in the responses, including but not limited to:
- Logical fallacies (e.g., ad hominem, straw man, false dichotomy)
- Cognitive biases (e.g., confirmation bias, anchoring bias)
- Faulty premises or assumptions
- Inconsistencies or contradictions
- Gaps in reasoning or missing information
- Over generalizations or hasty conclusions

Task 3: Synthesized Response
Based on your analysis and evaluation:
1. Construct a comprehensive, logically sound reasoning process to determine the most accurate answer.
2. Present the final answer in the format specified by the original question.

Guidelines:
- Maintain objectivity throughout your analysis and synthesis
- Support your conclusions with clear, logical arguments
- Acknowledge any remaining uncertainties or areas where further information might be needed
- Ensure your final answer directly addresses the user's original question
        `;

		return await this.mediator.generateText(systemPrompt!, mergePrompt, { temperature: 0.6 });
	}
}
