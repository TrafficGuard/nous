import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import pLimit from 'p-limit';
import { logger } from '#o11y/logger';
import { span } from '#o11y/trace';
import { readFilesToIndex } from '../codeLoader';
import { LLMCodeTranslator } from '../core/codeTranslator';
import type { RerankingConfig, VectorStoreConfig } from '../core/config';
import { addOrUpdateVectorConfig, loadVectorConfig, printConfigSummary } from '../core/config';
import { LLMContextualizer } from '../core/contextualizer';
import type { IChunker, IEmbedder, IReranker } from '../core/interfaces';
import type {
	ContextualizedChunk,
	EmbeddedChunk,
	FileInfo,
	IVectorSearchOrchestrator,
	ProgressCallback,
	RawChunk,
	SearchResult,
	VectorSearchOptions,
} from '../core/interfaces';
import { OLLAMA_EMBEDDING_MODELS, OllamaEmbedderAdapter } from '../ollama/ollamaEmbedder';
import { createReranker } from '../reranking';
import { MerkleSynchronizer } from '../sync/merkleSynchronizer';
import { QdrantAdapter } from './qdrantAdapter';
import type { QdrantConfig } from './qdrantConfig';
import { buildQdrantConfig } from './qdrantConfig';

const FILE_PROCESSING_PARALLEL_BATCH_SIZE = 5;

interface IndexingStats {
	fileCount: number;
	filesProcessed: number;
	failedFiles: string[];
	totalChunks: number;
	failedChunks: number;
}

export class QdrantOrchestrator implements IVectorSearchOrchestrator {
	private config: VectorStoreConfig;
	private qdrantConfig: QdrantConfig;
	private repoIdentifier: string;
	private _chunker: IChunker | null = null;
	private contextualizer: LLMContextualizer;
	private translator: LLMCodeTranslator;
	private embedder: IEmbedder;
	private vectorStore: QdrantAdapter;
	private synchronizer: MerkleSynchronizer;
	private _reranker: IReranker | null = null;
	private _rerankerConfig: RerankingConfig | null = null;

	constructor(repoIdentifier: string, config?: VectorStoreConfig) {
		this.repoIdentifier = repoIdentifier;
		this.config = config || {
			chunking: { dualEmbedding: false, contextualChunking: false },
			embedding: { provider: 'ollama', model: OLLAMA_EMBEDDING_MODELS.NOMIC_EMBED_CODE.model },
		};

		this.embedder = this.createEmbedder();
		this.qdrantConfig = buildQdrantConfig(this.config, this.embedder.getDimension());
		this.contextualizer = new LLMContextualizer();
		this.translator = new LLMCodeTranslator();
		this.vectorStore = new QdrantAdapter(repoIdentifier, this.qdrantConfig);
		this.synchronizer = new MerkleSynchronizer(this.config.includePatterns);
	}

	private async getChunker(): Promise<IChunker> {
		if (!this._chunker) {
			const { ASTChunker } = await import('../chunking/astChunker.js');
			this._chunker = new ASTChunker();
		}
		return this._chunker!;
	}

	private createEmbedder(): IEmbedder {
		const provider = this.config.embedding?.provider || 'ollama';
		const model = this.config.embedding?.model;

		if (provider === 'ollama') {
			let modelName: string = OLLAMA_EMBEDDING_MODELS.NOMIC_EMBED_CODE.model;
			let dimension: number = OLLAMA_EMBEDDING_MODELS.NOMIC_EMBED_CODE.dimension;

			if (model) {
				const foundConfig = Object.values(OLLAMA_EMBEDDING_MODELS).find((m) => m.model === model);
				if (foundConfig) {
					modelName = foundConfig.model;
					dimension = foundConfig.dimension;
				} else {
					modelName = model;
					dimension = 768;
				}
			}

			return new OllamaEmbedderAdapter({
				apiUrl: this.config.ollama?.apiUrl,
				model: modelName,
				dimension: dimension,
			});
		}

		return new OllamaEmbedderAdapter({
			apiUrl: this.config.ollama?.apiUrl,
			model: OLLAMA_EMBEDDING_MODELS.NOMIC_EMBED_CODE.model,
			dimension: OLLAMA_EMBEDDING_MODELS.NOMIC_EMBED_CODE.dimension,
		});
	}

	private getReranker(): IReranker | null {
		const config = this.config.search?.reranking;
		if (!config) return null;

		if (!this._reranker || !this.configsEqual(this._rerankerConfig, config)) {
			this._reranker = createReranker(config, undefined, this.config.ollama);
			this._rerankerConfig = config;
		}
		return this._reranker;
	}

	private configsEqual(a: RerankingConfig | null, b: RerankingConfig | null): boolean {
		if (a === b) return true;
		if (!a || !b) return false;
		return a.provider === b.provider && a.model === b.model && a.topK === b.topK;
	}

	@span()
	async indexRepository(
		repoRoot: string,
		options?: {
			subFolder?: string;
			incremental?: boolean;
			config?: VectorStoreConfig;
			onProgress?: ProgressCallback;
		},
	): Promise<void> {
		const startTime = Date.now();

		if (!options?.config) {
			try {
				this.config = loadVectorConfig(repoRoot);
			} catch {
				logger.info('No .typedai.json found, using default config');
			}
		} else {
			this.config = { ...this.config, ...options.config };
		}

		printConfigSummary(this.config);

		this.embedder = this.createEmbedder();
		this.qdrantConfig = buildQdrantConfig(this.config, this.embedder.getDimension());
		this.vectorStore = new QdrantAdapter(this.repoIdentifier, this.qdrantConfig);

		if (this.embedder instanceof OllamaEmbedderAdapter) {
			const available = await this.embedder.isAvailable();
			if (!available) {
				throw new Error(
					`Ollama is not available or model "${this.embedder.getModel()}" is not loaded.\nStart Ollama with: ollama serve\nPull the model with: ollama pull ${this.embedder.getModel()}`,
				);
			}
		}

		const qdrantAvailable = await this.vectorStore.isAvailable();
		if (!qdrantAvailable) {
			throw new Error(
				`Qdrant is not available at ${this.qdrantConfig.url}.\nStart Qdrant with: docker run -p 6333:6333 qdrant/qdrant\nOr download from: https://qdrant.tech/documentation/quick-start/`,
			);
		}

		await this.vectorStore.initialize(this.config);

		logger.info({ repoRoot, incremental: options?.incremental }, 'Starting repository indexing');

		let filesToIndex: string[];

		if (options?.incremental) {
			logger.info('Performing incremental update using Merkle sync');
			const changes = await this.synchronizer.detectChanges(repoRoot);

			filesToIndex = [...changes.added, ...changes.modified];

			for (const deletedFile of changes.deleted) {
				await this.vectorStore.deleteByFilePath(deletedFile);
			}

			logger.info(
				{
					added: changes.added.length,
					modified: changes.modified.length,
					deleted: changes.deleted.length,
				},
				'Incremental changes detected',
			);

			if (filesToIndex.length === 0) {
				return;
			}
		} else {
			logger.info('Performing full repository indexing');
			const codeFiles = await readFilesToIndex(repoRoot, options?.subFolder || './', this.config.includePatterns);
			filesToIndex = codeFiles.map((f) => f.filePath);
			logger.info({ fileCount: codeFiles.length }, 'Loaded code files');
		}

		if (filesToIndex.length === 0) return;

		await this.indexFiles(repoRoot, filesToIndex, options?.onProgress);
		await this.synchronizer.saveSnapshot(repoRoot, filesToIndex);

		addOrUpdateVectorConfig(repoRoot, { ...this.config, indexed: true });

		const duration = Date.now() - startTime;
		logger.info({ duration, fileCount: filesToIndex.length }, 'Repository indexing completed, indexed=true set');
	}

	async search(query: string, options?: VectorSearchOptions): Promise<SearchResult[]> {
		const maxResults = options?.maxResults || 10;
		const rerankConfig = this.config.search?.reranking;
		const useReranking = options?.reranking ?? !!rerankConfig;
		const rerankingTopK = rerankConfig?.topK ?? 50;
		const useHybridSearch = options?.hybridSearch ?? this.config.search?.hybridSearch ?? true;

		logger.info({ query, maxResults, reranking: useReranking, rerankingProvider: rerankConfig?.provider, hybridSearch: useHybridSearch }, 'Performing search');

		const queryEmbedding = await this.embedder.embed(query, 'RETRIEVAL_QUERY');
		const searchLimit = useReranking ? Math.max(maxResults * 2, rerankingTopK) : maxResults;
		const searchConfig = { ...this.config, search: { ...this.config.search, hybridSearch: useHybridSearch } };
		const results = await this.vectorStore.search(query, queryEmbedding, searchLimit, searchConfig);

		let filteredResults = results;

		if (options?.fileFilter && options.fileFilter.length > 0) {
			filteredResults = filteredResults.filter((r) => options.fileFilter!.some((filter) => r.document.filePath.includes(filter)));
		}

		if (options?.languageFilter && options.languageFilter.length > 0) {
			filteredResults = filteredResults.filter((r) => options.languageFilter!.includes(r.document.language));
		}

		let finalResults = filteredResults;

		if (useReranking && filteredResults.length > 0) {
			const reranker = this.getReranker();
			if (reranker) {
				logger.info({ inputCount: filteredResults.length, maxResults, rerankingTopK }, 'Applying reranking');
				finalResults = await reranker.rerank(query, filteredResults, maxResults);
			} else {
				finalResults = filteredResults.slice(0, maxResults);
			}
		} else {
			finalResults = filteredResults.slice(0, maxResults);
		}

		logger.info({ resultCount: finalResults.length, reranked: useReranking }, 'Search completed');

		return finalResults;
	}

	getConfig(): VectorStoreConfig {
		return this.config;
	}

	updateConfig(config: Partial<VectorStoreConfig>): void {
		this.config = { ...this.config, ...config };
		logger.info({ config: this.config }, 'Configuration updated');
	}

	private async indexFiles(repoRoot: string, filePaths: string[], onProgress?: ProgressCallback): Promise<void> {
		const stats: IndexingStats = {
			fileCount: filePaths.length,
			filesProcessed: 0,
			failedFiles: [],
			totalChunks: 0,
			failedChunks: 0,
		};

		const limit = pLimit(FILE_PROCESSING_PARALLEL_BATCH_SIZE);
		logger.info({ fileCount: filePaths.length, concurrency: FILE_PROCESSING_PARALLEL_BATCH_SIZE }, 'Starting parallel file indexing');

		const processingPromises = filePaths.map((filePath) =>
			limit(async () => {
				try {
					onProgress?.({
						phase: 'loading',
						currentFile: filePath,
						filesProcessed: stats.filesProcessed,
						totalFiles: stats.fileCount,
					});

					const fileInfo = await this.loadFile(repoRoot, filePath);
					const chunks = await this.processFile(fileInfo, stats, onProgress);

					if (chunks.length > 0) {
						onProgress?.({
							phase: 'indexing',
							currentFile: filePath,
							filesProcessed: stats.filesProcessed,
							totalFiles: stats.fileCount,
							chunksProcessed: chunks.length,
						});

						await this.vectorStore.indexChunks(chunks);
						stats.totalChunks += chunks.length;
					}

					stats.filesProcessed++;
					logger.debug({ filePath, chunkCount: chunks.length }, 'File indexed successfully');
				} catch (error) {
					stats.failedFiles.push(filePath);
					logger.error({ error, filePath }, 'Failed to process file');
				}
			}),
		);

		await Promise.all(processingPromises);

		logger.info(
			{
				filesProcessed: stats.filesProcessed,
				failedFiles: stats.failedFiles.length,
				totalChunks: stats.totalChunks,
				failedChunks: stats.failedChunks,
			},
			'File indexing completed',
		);
	}

	private async processFile(fileInfo: FileInfo, stats: IndexingStats, onProgress?: ProgressCallback): Promise<EmbeddedChunk[]> {
		try {
			let chunks: Array<RawChunk | ContextualizedChunk>;

			if (this.config.chunking?.contextualChunking) {
				onProgress?.({
					phase: 'contextualizing',
					currentFile: fileInfo.filePath,
					filesProcessed: stats.filesProcessed,
					totalFiles: stats.fileCount,
				});

				chunks = await this.contextualizer.contextualize([], fileInfo, this.config);
			} else {
				onProgress?.({
					phase: 'chunking',
					currentFile: fileInfo.filePath,
					filesProcessed: stats.filesProcessed,
					totalFiles: stats.fileCount,
				});

				const chunker = await this.getChunker();
				chunks = await chunker.chunk(fileInfo, this.config);
			}

			if (chunks.length === 0) {
				logger.debug({ filePath: fileInfo.filePath }, 'No chunks generated');
				return [];
			}

			onProgress?.({
				phase: 'embedding',
				currentFile: fileInfo.filePath,
				filesProcessed: stats.filesProcessed,
				totalFiles: stats.fileCount,
				chunksProcessed: 0,
				totalChunks: chunks.length,
			});

			const contextualizedTexts = chunks.map((chunk) => ('contextualizedContent' in chunk ? chunk.contextualizedContent : chunk.content));
			const primaryEmbeddings = await this.embedder.embedBatch(contextualizedTexts, 'RETRIEVAL_DOCUMENT');

			logger.debug({ chunkCount: chunks.length }, 'Generated embeddings');

			return chunks.map((chunk, index) => ({
				filePath: fileInfo.filePath,
				language: fileInfo.language,
				chunk,
				embedding: primaryEmbeddings[index],
			}));
		} catch (error) {
			logger.error({ error, filePath: fileInfo.filePath }, 'Failed to process file');
			throw error;
		}
	}

	private async loadFile(repoRoot: string, filePath: string): Promise<FileInfo> {
		const fullPath = path.join(repoRoot, filePath);
		const content = await fs.readFile(fullPath, 'utf-8');
		const stats = await fs.stat(fullPath);

		return {
			filePath,
			relativePath: filePath,
			language: this.detectLanguage(path.extname(filePath)),
			content,
			size: stats.size,
			lastModified: stats.mtime,
		};
	}

	private detectLanguage(extension: string): string {
		const languageMap: Record<string, string> = {
			'.ts': 'typescript',
			'.tsx': 'typescript',
			'.js': 'javascript',
			'.jsx': 'javascript',
			'.py': 'python',
			'.java': 'java',
			'.cpp': 'cpp',
			'.c': 'c',
			'.h': 'c',
			'.go': 'go',
			'.rs': 'rust',
			'.rb': 'ruby',
			'.php': 'php',
			'.cs': 'csharp',
			'.swift': 'swift',
			'.kt': 'kotlin',
		};

		return languageMap[extension.toLowerCase()] || 'unknown';
	}

	async getStats(): Promise<{ totalDocuments: number; totalChunks: number; storageSize?: number }> {
		return this.vectorStore.getStats();
	}

	async purge(): Promise<void> {
		await this.vectorStore.purge();
	}
}
