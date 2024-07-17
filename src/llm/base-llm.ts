import { CDATA_END, CDATA_START } from '#utils/xml-utils';
import { FunctionResponse, GenerateFunctionOptions, GenerateJsonOptions, GenerateTextOptions, LLM } from './llm';
import { extractJsonResult, extractStringResult, parseFunctionCallsXml } from './responseParsers';

export interface SerializedLLM {
	service: string;
	model: string;
}

export abstract class BaseLLM implements LLM {
	constructor(
		protected readonly displayName: string,
		protected readonly service: string,
		protected readonly model: string,
		private maxInputTokens: number,
		public readonly calculateInputCost: (input: string) => number,
		public readonly calculateOutputCost: (output: string) => number,
	) {}

	async generateFunctionResponse(prompt: string, systemPrompt?: string, opts?: GenerateFunctionOptions): Promise<FunctionResponse> {
		const response = await this.generateText(prompt, systemPrompt, opts);
		return {
			textResponse: response,
			functions: parseFunctionCallsXml(response),
		};
	}

	async generateTextWithResult(prompt: string, systemPrompt?: string, opts?: GenerateTextOptions): Promise<string> {
		const response = await this.generateText(prompt, systemPrompt, opts);
		return extractStringResult(response);
	}

	async generateJson(prompt: string, systemPrompt?: string, opts?: GenerateJsonOptions): Promise<any> {
		const response = await this.generateText(prompt, systemPrompt, opts ? { type: 'json', ...opts } : { type: 'json' });
		return extractJsonResult(response);
	}

	abstract generateText(prompt: string, systemPrompt?: string, opts?: GenerateTextOptions): Promise<string>;

	getMaxInputTokens(): number {
		return this.maxInputTokens;
	}

	isRetryableError(e: any): boolean {
		return false;
	}

	getModel(): string {
		return this.model;
	}

	getService(): string {
		return this.service;
	}

	getId(): string {
		return `${this.service}:${this.model}`;
	}

	getDisplayName(): string {
		return this.displayName;
	}
}
