import axios from 'axios';
import { addCost, agentContext } from '#agent/agentContext';
import { CallerId } from '#llm/llmCallService/llmCallService';
import { CreateLlmResponse } from '#llm/llmCallService/llmRequestResponse';
import { withSpan } from '#o11y/trace';
import { currentUser } from '#user/userService/userContext';
import { sleep } from '#utils/async-utils';
import { envVar } from '#utils/env-var';
import { appContext } from '../../app';
import { RetryableError } from '../../cache/cacheRetry';
import { BaseLLM } from '../base-llm';
import { GenerateTextOptions, LLM, combinePrompts, logTextGeneration } from '../llm';

export const DEEPSEEK_SERVICE = 'deepseek';

export function deepseekLLMRegistry(): Record<string, () => LLM> {
	return {
		[`${DEEPSEEK_SERVICE}:deepseek-coder`]: () => deepseekCoder(),
		[`${DEEPSEEK_SERVICE}:deepseek-chat`]: () => deepseekChat(),
	};
}

export function deepseekCoder(): LLM {
	return new DeepseekLLM('DeepSeek Coder', 'deepseek-coder', 32000, 0.14 / (1_000_000 * 3.5), 0.28 / (1_000_000 * 3.5));
}

export function deepseekChat(): LLM {
	return new DeepseekLLM('DeepSeek Chat', 'deepseek-chat', 32000, 0.14 / (1_000_000 * 3.5), 0.28 / (1_000_000 * 3.5));
}

/**
 * Deepseek models
 * @see https://platform.deepseek.com/api-docs/api/create-chat-completion
 */
export class DeepseekLLM extends BaseLLM {
	_client: any;

	client() {
		if (!this._client) {
			this._client = axios.create({
				baseURL: 'https://api.deepseek.com',
				headers: {
					Authorization: `Bearer ${currentUser().llmConfig.deepseekKey ?? envVar('DEEPSEEK_API_KEY')}`,
				},
			});
		}
		return this._client;
	}

	constructor(displayName: string, model: string, maxTokens: number, inputCostPerToken: number, outputCostPerToken: number) {
		super(displayName, DEEPSEEK_SERVICE, model, maxTokens, inputCostPerToken, outputCostPerToken);
	}

	@logTextGeneration
	async generateText(userPrompt: string, systemPrompt?: string, opts?: GenerateTextOptions): Promise<string> {
		return withSpan(`generateText ${opts?.id ?? ''}`, async (span) => {
			const prompt = combinePrompts(userPrompt, systemPrompt);

			if (systemPrompt) span.setAttribute('systemPrompt', systemPrompt);
			span.setAttributes({
				userPrompt,
				inputChars: prompt.length,
				model: this.model,
				service: this.service,
			});

			const caller: CallerId = { agentId: agentContext().agentId };
			const llmRequestSave = appContext().llmCallService.saveRequest(userPrompt, systemPrompt);
			const requestTime = Date.now();

			const messages = [];
			if (systemPrompt) {
				messages.push({
					role: 'system',
					content: systemPrompt,
				});
			}
			messages.push({
				role: 'user',
				content: userPrompt,
			});

			try {
				const response = await this.client().post('/chat/completions', {
					messages,
					model: this.model,
				});

				const responseText = response.data.choices[0].message.content;

				const timeToFirstToken = Date.now() - requestTime;
				const finishTime = Date.now();
				const llmRequest = await llmRequestSave;
				const llmResponse: CreateLlmResponse = {
					llmId: this.getId(),
					llmRequestId: llmRequest.id,
					responseText,
					requestTime,
					timeToFirstToken: timeToFirstToken,
					totalTime: finishTime - requestTime,
					callStack: agentContext().callStack.join(' > '),
				};
				await appContext().llmCallService.saveResponse(llmRequest.id, caller, llmResponse);

				const inputCost = this.getInputCostPerToken() * prompt.length;
				const outputCost = this.getOutputCostPerToken() * responseText.length;
				const cost = inputCost + outputCost;

				span.setAttributes({
					response: responseText,
					timeToFirstToken,
					inputCost,
					outputCost,
					cost,
					outputChars: responseText.length,
				});

				addCost(cost);

				return responseText;
			} catch (e) {
				// Free accounts are limited to 1 query/second
				if (e.message.includes('rate limiting')) {
					await sleep(1000);
					throw new RetryableError(e);
				}
				throw e;
			}
		});
	}

	isRetryableError(e: any): boolean {
		return e.message.includes('rate limiting');
	}
}
