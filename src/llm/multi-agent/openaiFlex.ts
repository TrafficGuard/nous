import type { TextStreamPart } from 'ai';
import { BaseLLM } from '#llm/base-llm';
import { openaiGPT5, openaiGPT5mini, openaiGPT5nano } from '#llm/services/openai';
import { logger } from '#o11y/logger';
import type { GenerateTextOptions, GenerationStats, LLM, LlmMessage } from '#shared/llm/llm.model';
import { sleep } from '#utils/async-utils';
import { isQuotaError, parseRetryDelay } from '#utils/quotaRetry';

export const OPENAI_FLEX_SERVICE = 'openai_flex';

const DEFAULT_FLEX_TIMEOUT_MS = 5 * 60 * 1000; // default 5 minutes
const DEFAULT_RATE_LIMIT_RETRIES = 10;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 1000;

export function openAIFlexLLMRegistry(): Array<() => LLM> {
	return [openAIFlexGPT5, openAIFlexGPT5Mini];
}

export function openAIFlexGPT5(): LLM {
	return new OpenAIFlex('GPT5 Flex', 'gpt-5', openaiGPT5(), openaiGPT5('flex'));
}

export function openAIFlexGPT5Mini(): LLM {
	return new OpenAIFlex('GPT5 Mini Flex', 'gpt-5-mini', openaiGPT5mini(), openaiGPT5mini('flex'));
}

export function openAIFlexGPT5Nano(): LLM {
	return new OpenAIFlex('GPT5 Nano Flex', 'gpt-5-nano', openaiGPT5nano(), openaiGPT5nano('flex'));
}

/*
Flex processing (OpenAI documentation)

Optimize costs with flex processing.

Flex processing provides lower costs for [Responses](/docs/api-reference/responses) or [Chat Completions](/docs/api-reference/chat) requests in exchange for slower response times and occasional resource unavailability. It's ideal for non-production or lower priority tasks, such as model evaluations, data enrichment, and asynchronous workloads.

Tokens are [priced](/docs/pricing) at [Batch API rates](/docs/guides/batch), with additional discounts from [prompt caching](/docs/guides/prompt-caching).

Flex processing is in beta and currently only available for [GPT-5](/docs/models/gpt-5), [o3](/docs/models/o3), and [o4-mini](/docs/models/o4-mini) models.

API usage
---------

To use Flex processing, set the `service_tier` parameter to `flex` in your API request:

Flex processing example

```javascript
import OpenAI from "openai";
const client = new OpenAI({
    timeout: 15 * 1000 * 60, // Increase default timeout to 15 minutes
});

const response = await client.responses.create({
    model: "o3",
    instructions: "List and describe all the metaphors used in this book.",
    input: "<very long text of book here>",
    service_tier: "flex",
}, { timeout: 15 * 1000 * 60 });

console.log(response.output_text);
```

#### API request timeouts

Due to slower processing speeds with Flex processing, request timeouts are more likely. Here are some considerations for handling timeouts:

*   **Default timeout**: The default timeout is **10 minutes** when making API requests with an official OpenAI SDK. You may need to increase this timeout for lengthy prompts or complex tasks.
*   **Configuring timeouts**: Each SDK will provide a parameter to increase this timeout. In the Python and JavaScript SDKs, this is `timeout` as shown in the code samples above.
*   **Automatic retries**: The OpenAI SDKs automatically retry requests that result in a `408 Request Timeout` error code twice before throwing an exception.

Resource unavailable errors
---------------------------

Flex processing may sometimes lack sufficient resources to handle your requests, resulting in a `429 Resource Unavailable` error code. **You will not be charged when this occurs.**

Consider implementing these strategies for handling resource unavailable errors:

*   **Retry requests with exponential backoff**: Implementing exponential backoff is suitable for workloads that can tolerate delays and aims to minimize costs, as your request can eventually complete when more capacity is available. For implementation details, see [this cookbook](https://cookbook.openai.com/examples/how_to_handle_rate_limits?utm_source=chatgpt.com#retrying-with-exponential-backoff).
    
*   **Retry requests with standard processing**: When receiving a resource unavailable error, implement a retry strategy with standard processing if occasional higher costs are worth ensuring successful completion for your use case. To do so, set `service_tier` to `auto` in the retried request, or remove the `service_tier` parameter to use the default mode for the project.

# Stopping streams

import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';

export async function POST(req: Request) {
  const { prompt } = await req.json();

  const result = streamText({
    model: openai('gpt-4.1'),
    prompt,
    // forward the abort signal:
    abortSignal: req.signal,
    onAbort: ({ steps }) => {
      // Handle cleanup when stream is aborted
      console.log('Stream aborted after', steps.length, 'steps');
      // Persist partial results to database
    },
  });

  return result.toTextStreamResponse();
}

(End OpenAI documentation)
*/

/*
# OpenAIFlex class requirements

This class uses a combination GPT5 with the standard and flex service tiers, to reduce costs.
Call(s) are made with the flex tier, up to a timeout configured in the class.
If there has not been a response with the flex tier configuration, then a call will be made with the standard tier to ensure progress continues.

The generateTextFromMessages implementation will call the flex tier first in streaming mode. If the flex tier call has started to receive a response,
then we will cancel any timeouts and continue with the flex tier call.

If the flex tier call does not start to receive a response within the timeout, then we will cancel the flex tier call and make a call with the standard tier.

We want to be able to collect statistics on how long it takes for the flex tier to start recieving a response, and how often we need to fallback to the standard tier.
*/

interface StreamAttemptConfig {
	collectText?: boolean;
	onChunk?: (chunk: TextStreamPart<any>) => void;
}

interface StreamAttemptResult {
	stats: GenerationStats;
	text?: string;
}

interface StreamAttempt {
	completion: Promise<StreamAttemptResult>;
	firstChunk: Promise<number>;
	hasFirstChunk(): boolean;
	abort(): void;
	suppressCompletionErrors(): void;
}

export interface FlexMetricsSnapshot {
	flexAttempts: number;
	flexFallbacks: number;
	flexResponses: number;
	lastFlexResponseMs?: number;
	averageFlexResponseMs?: number;
}

export class OpenAIFlex extends BaseLLM {
	private readonly flexTimeoutMs: number;
	private readonly metrics = {
		flexAttempts: 0,
		flexFallbacks: 0,
		flexResponses: 0,
		flexResponseTotalMs: 0,
		lastFlexResponseMs: undefined as number | undefined,
	};

	constructor(
		displayName: string,
		model: string,
		private readonly standardLLM: LLM,
		private readonly flexLLM: LLM,
		timeoutMs?: number,
	) {
		super({
			displayName,
			service: OPENAI_FLEX_SERVICE,
			modelId: model,
			maxInputTokens: standardLLM.getMaxInputTokens(),
			calculateCosts: () => ({ inputCost: 0, outputCost: 0, totalCost: 0 }),
		});
		this.flexTimeoutMs = timeoutMs ?? DEFAULT_FLEX_TIMEOUT_MS;
	}

	protected override supportsGenerateTextFromMessages(): boolean {
		return true;
	}

	override isConfigured(): boolean {
		return this.standardLLM.isConfigured() && this.flexLLM.isConfigured();
	}

	getMetrics(): FlexMetricsSnapshot {
		const { flexAttempts, flexFallbacks, flexResponses, flexResponseTotalMs, lastFlexResponseMs } = this.metrics;
		return {
			flexAttempts,
			flexFallbacks,
			flexResponses,
			lastFlexResponseMs,
			averageFlexResponseMs: flexResponses > 0 ? Math.round(flexResponseTotalMs / flexResponses) : undefined,
		};
	}

	override async _generateMessage(messages: LlmMessage[], opts?: GenerateTextOptions): Promise<LlmMessage> {
		try {
			return await this.flexLLM.generateMessage(messages, opts);
		} catch (error) {
			return await this.standardLLM.generateMessage(messages, opts);
		}
	}

	override async generateTextFromMessages(messages: LlmMessage[], opts?: GenerateTextOptions): Promise<string> {
		for (let rateLimitAttempt = 0; rateLimitAttempt < DEFAULT_RATE_LIMIT_RETRIES; rateLimitAttempt++) {
			const startTime = Date.now();
			this.recordFlexAttempt();

			const flexAttempt = this.createStreamAttempt(this.flexLLM, messages, opts, { collectText: true });
			let fallbackReason: 'timeout' | 'error-before-response' | null = null;
			let caughtError: unknown = null;

			const timeoutHandle = this.createTimeout(() => {
				if (flexAttempt.hasFirstChunk()) return;
				fallbackReason = 'timeout';
				flexAttempt.abort();
			}, this.flexTimeoutMs);

			try {
				const firstChunkTimestamp = await flexAttempt.firstChunk;
				clearTimeout(timeoutHandle);
				this.recordFlexResponse(firstChunkTimestamp - startTime);
			} catch (error) {
				clearTimeout(timeoutHandle);
				caughtError = error;
				if (!fallbackReason) fallbackReason = 'error-before-response';
			}

			if (fallbackReason) {
				flexAttempt.abort();
				flexAttempt.suppressCompletionErrors();

				// Check if this is a rate limit error - if so, retry flex tier instead of falling back
				if (caughtError && isQuotaError(caughtError)) {
					const retryDelay = parseRetryDelay(caughtError) ?? DEFAULT_RATE_LIMIT_BACKOFF_MS * 2 ** rateLimitAttempt;
					logger.info({ model: this.getId(), attempt: rateLimitAttempt + 1, retryDelay }, 'OpenAIFlex rate limit hit, retrying flex tier after delay.');
					await sleep(retryDelay + 100); // Add small buffer
					continue;
				}

				this.recordFallback(fallbackReason);
				return await this.standardLLM.generateText(messages, opts);
			}

			try {
				const result = await flexAttempt.completion;
				return result.text ?? '';
			} catch (error) {
				// Check if completion error is a rate limit error
				if (isQuotaError(error)) {
					const retryDelay = parseRetryDelay(error) ?? DEFAULT_RATE_LIMIT_BACKOFF_MS * 2 ** rateLimitAttempt;
					logger.info(
						{ model: this.getId(), attempt: rateLimitAttempt + 1, retryDelay },
						'OpenAIFlex rate limit hit during completion, retrying flex tier after delay.',
					);
					await sleep(retryDelay + 100);
					continue;
				}

				this.recordFallback('error-after-response');
				return await this.standardLLM.generateText(messages, opts);
			}
		}

		// Exhausted rate limit retries, fall back to standard tier
		logger.warn({ model: this.getId() }, 'OpenAIFlex exhausted rate limit retries, falling back to standard tier.');
		this.recordFallback('rate-limit-retries-exhausted');
		return await this.standardLLM.generateText(messages, opts);
	}

	override async streamText(
		messages: LlmMessage[] | ReadonlyArray<LlmMessage>,
		onChunk: (chunk: TextStreamPart<any>) => void,
		opts?: GenerateTextOptions,
	): Promise<GenerationStats> {
		for (let rateLimitAttempt = 0; rateLimitAttempt < DEFAULT_RATE_LIMIT_RETRIES; rateLimitAttempt++) {
			const startTime = Date.now();
			this.recordFlexAttempt();

			let selected: 'flex' | 'standard' | null = null;
			const flexAttempt = this.createStreamAttempt(this.flexLLM, messages as LlmMessage[], opts, {
				onChunk: (chunk) => {
					if (selected === null && this.isMeaningfulChunk(chunk)) selected = 'flex';
					if (selected === 'flex') onChunk(chunk);
				},
			});

			let fallbackReason: 'timeout' | 'error-before-response' | null = null;
			let caughtError: unknown = null;
			const timeoutHandle = this.createTimeout(() => {
				if (flexAttempt.hasFirstChunk()) return;
				fallbackReason = 'timeout';
				flexAttempt.abort();
			}, this.flexTimeoutMs);

			let firstChunkArrived = false;
			try {
				const firstChunkTimestamp = await flexAttempt.firstChunk;
				clearTimeout(timeoutHandle);
				firstChunkArrived = true;
				this.recordFlexResponse(firstChunkTimestamp - startTime);
			} catch (error) {
				clearTimeout(timeoutHandle);
				caughtError = error;
				if (!fallbackReason) fallbackReason = 'error-before-response';
			}

			if (!firstChunkArrived) {
				flexAttempt.abort();
				flexAttempt.suppressCompletionErrors();

				// Check if this is a rate limit error - if so, retry flex tier instead of falling back
				if (caughtError && isQuotaError(caughtError)) {
					const retryDelay = parseRetryDelay(caughtError) ?? DEFAULT_RATE_LIMIT_BACKOFF_MS * 2 ** rateLimitAttempt;
					logger.info({ model: this.getId(), attempt: rateLimitAttempt + 1, retryDelay }, 'OpenAIFlex rate limit hit, retrying flex tier after delay.');
					await sleep(retryDelay + 100); // Add small buffer
					continue;
				}

				this.recordFallback(fallbackReason ?? 'error-before-response');
				selected = 'standard';
				return await this.standardLLM.streamText(messages as LlmMessage[], onChunk, opts);
			}

			try {
				const { stats } = await flexAttempt.completion;
				return stats;
			} catch (error) {
				// Check if completion error is a rate limit error
				if (isQuotaError(error)) {
					const retryDelay = parseRetryDelay(error) ?? DEFAULT_RATE_LIMIT_BACKOFF_MS * 2 ** rateLimitAttempt;
					logger.info(
						{ model: this.getId(), attempt: rateLimitAttempt + 1, retryDelay },
						'OpenAIFlex rate limit hit during completion, retrying flex tier after delay.',
					);
					await sleep(retryDelay + 100);
					continue;
				}

				this.recordFallback('error-after-response');
				selected = 'standard';
				return await this.standardLLM.streamText(messages as LlmMessage[], onChunk, opts);
			}
		}

		// Exhausted rate limit retries, fall back to standard tier
		logger.warn({ model: this.getId() }, 'OpenAIFlex exhausted rate limit retries, falling back to standard tier.');
		this.recordFallback('rate-limit-retries-exhausted');
		return await this.standardLLM.streamText(messages as LlmMessage[], onChunk, opts);
	}

	private createStreamAttempt(
		llm: LLM,
		messages: LlmMessage[] | ReadonlyArray<LlmMessage>,
		opts: GenerateTextOptions | undefined,
		config: StreamAttemptConfig,
	): StreamAttempt {
		const abortController = new AbortController();
		const attemptOpts = this.cloneOptionsWithAbort(opts, abortController.signal);
		let firstChunkSeen = false;
		let firstChunkSettled = false;
		let aborted = false;
		let textBuffer = '';

		let resolveFirstChunk: (value: number) => void;
		let rejectFirstChunk: (reason?: unknown) => void;
		const firstChunk = new Promise<number>((resolve, reject) => {
			resolveFirstChunk = resolve;
			rejectFirstChunk = reject;
		});

		const settleFirstChunk = (value: number) => {
			if (firstChunkSettled) return;
			firstChunkSettled = true;
			resolveFirstChunk(value);
		};

		const failFirstChunk = (reason: unknown) => {
			if (firstChunkSettled) return;
			firstChunkSettled = true;
			rejectFirstChunk(reason);
		};

		const completion = llm
			.streamText(
				messages as LlmMessage[],
				(chunk) => {
					if (!firstChunkSeen && this.isMeaningfulChunk(chunk)) {
						firstChunkSeen = true;
						settleFirstChunk(Date.now());
					}
					if (config.collectText && chunk.type === 'text-delta') textBuffer += chunk.text;
					config.onChunk?.(chunk);
				},
				attemptOpts,
			)
			.then((stats) => {
				if (!firstChunkSeen) failFirstChunk(new Error('flex-no-response'));
				return {
					stats,
					text: config.collectText ? textBuffer : undefined,
				};
			})
			.catch((error) => {
				failFirstChunk(error);
				throw error;
			});

		return {
			completion,
			firstChunk,
			hasFirstChunk: () => firstChunkSeen,
			abort: () => {
				if (aborted) return;
				aborted = true;
				abortController.abort();
				failFirstChunk(new Error('flex-aborted'));
			},
			suppressCompletionErrors: () => {
				void completion.catch(() => undefined);
			},
		};
	}

	private cloneOptionsWithAbort(opts: GenerateTextOptions | undefined, abortSignal: AbortSignal): GenerateTextOptions {
		const cloned: GenerateTextOptions = { ...(opts ?? {}) };
		if (opts?.providerOptions) cloned.providerOptions = { ...opts.providerOptions };
		cloned.abortSignal = abortSignal;
		return cloned;
	}

	private createTimeout(onTimeout: () => void, timeoutMs: number): NodeJS.Timeout {
		return setTimeout(onTimeout, timeoutMs);
	}

	private isMeaningfulChunk(chunk: TextStreamPart<any>): boolean {
		switch (chunk.type) {
			case 'text-delta':
			case 'reasoning-delta':
			case 'tool-call':
			case 'tool-result':
			case 'tool-error':
			case 'source':
			case 'file':
			case 'tool-input-delta':
				return true;
			default:
				return false;
		}
	}

	private recordFlexAttempt(): void {
		this.metrics.flexAttempts += 1;
	}

	private recordFlexResponse(responseMs: number): void {
		if (Number.isNaN(responseMs)) return;
		this.metrics.flexResponses += 1;
		this.metrics.flexResponseTotalMs += responseMs;
		this.metrics.lastFlexResponseMs = responseMs;
	}

	private recordFallback(reason: string): void {
		this.metrics.flexFallbacks += 1;
		logger.info({ reason, model: this.getId() }, 'OpenAIFlex fallback to standard tier triggered.');
	}
}
