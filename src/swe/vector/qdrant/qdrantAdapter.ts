import { QdrantClient } from '@qdrant/js-client-rest';
import { v5 as uuidv5 } from 'uuid';
import { logger } from '#o11y/logger';
import type { VectorStoreConfig } from '../core/config';
import type { EmbeddedChunk, IVectorStore, SearchResult } from '../core/interfaces';
import type { QdrantConfig } from './qdrantConfig';
import { getCollectionNameForRepo } from './qdrantConfig';

export class QdrantAdapter implements IVectorStore {
	private client: QdrantClient;
	private config: VectorStoreConfig;
	private qdrantConfig: QdrantConfig;
	private collectionName: string;
	private initialized = false;

	constructor(repoIdentifier: string, qdrantConfig: QdrantConfig) {
		this.qdrantConfig = qdrantConfig;
		this.collectionName = getCollectionNameForRepo(repoIdentifier, qdrantConfig.collectionPrefix);
		this.config = { chunking: { dualEmbedding: false, contextualChunking: false } };
		this.client = new QdrantClient({ url: qdrantConfig.url, apiKey: qdrantConfig.apiKey });
	}

	async initialize(config: VectorStoreConfig): Promise<void> {
		this.config = config;
		logger.info({ collectionName: this.collectionName }, 'Initializing Qdrant adapter');

		try {
			const { collections } = await this.client.getCollections();
			if (!collections.some((c) => c.name === this.collectionName)) {
				await this.client.createCollection(this.collectionName, {
					vectors: {
						size: this.qdrantConfig.embeddingDimension,
						distance: this.qdrantConfig.distanceFunction || 'Cosine',
					},
				});

				for (const field of ['config_name', 'filename', 'language']) {
					await this.client.createPayloadIndex(this.collectionName, { field_name: field, field_schema: 'keyword' });
				}
				logger.info({ collectionName: this.collectionName }, 'Created collection');
			}

			this.initialized = true;
		} catch (error) {
			logger.error({ error, collectionName: this.collectionName }, 'Failed to initialize');
			throw error;
		}
	}

	private generatePointId(chunk: EmbeddedChunk): string {
		const key = `${chunk.filePath}:${chunk.chunk.sourceLocation.startLine}:${chunk.chunk.sourceLocation.endLine}`;
		return uuidv5(key, uuidv5.DNS);
	}

	private configFilter(configName: string) {
		return { must: [{ key: 'config_name', match: { value: configName } }] } as any;
	}

	async indexChunks(chunks: EmbeddedChunk[]): Promise<void> {
		if (!chunks.length) return;
		if (!this.initialized) throw new Error('Not initialized');

		const configName = this.config.name || 'default';
		logger.info({ chunkCount: chunks.length }, 'Indexing');

		for (let i = 0; i < chunks.length; i += 100) {
			const points = chunks.slice(i, i + 100).map((chunk) => ({
				id: this.generatePointId(chunk),
				vector: chunk.embedding,
				payload: {
					config_name: configName,
					filename: chunk.filePath,
					line_from: chunk.chunk.sourceLocation.startLine,
					line_to: chunk.chunk.sourceLocation.endLine,
					original_text: chunk.chunk.content,
					contextualized_text: 'contextualizedContent' in chunk.chunk ? chunk.chunk.contextualizedContent : chunk.chunk.content,
					language: chunk.language,
					chunk_type: chunk.chunk.chunkType,
					function_name: chunk.chunk.metadata?.functionName || '',
					class_name: chunk.chunk.metadata?.className || '',
					natural_language_description: chunk.naturalLanguageDescription || '',
				},
			}));

			await this.client.upsert(this.collectionName, { wait: true, points });
		}
	}

	async deleteByFilePath(filePath: string): Promise<number> {
		if (!this.initialized) throw new Error('Not initialized');

		const configName = this.config.name || 'default';
		const filter = {
			must: [
				{ key: 'filename', match: { value: filePath } },
				{ key: 'config_name', match: { value: configName } },
			],
		} as any;

		const { count } = await this.client.count(this.collectionName, { filter, exact: true });
		if (count > 0) {
			await this.client.delete(this.collectionName, { wait: true, filter });
			logger.info({ filePath, deletedCount: count }, 'Deleted');
		}
		return count;
	}

	async search(query: string, queryEmbedding: number[], maxResults: number, config: VectorStoreConfig): Promise<SearchResult[]> {
		if (!this.initialized) throw new Error('Not initialized');

		const results = await this.client.query(this.collectionName, {
			query: queryEmbedding,
			limit: maxResults,
			filter: this.configFilter(config.name || 'default'),
			with_payload: true,
			with_vector: false,
		});

		return results.points.map((r) => ({
			id: String(r.id),
			score: r.score,
			document: {
				filePath: String(r.payload?.filename || ''),
				functionName: r.payload?.function_name ? String(r.payload.function_name) : undefined,
				className: r.payload?.class_name ? String(r.payload.class_name) : undefined,
				startLine: Number(r.payload?.line_from) || 0,
				endLine: Number(r.payload?.line_to) || 0,
				language: String(r.payload?.language || 'unknown'),
				originalCode: String(r.payload?.original_text || ''),
				naturalLanguageDescription: r.payload?.natural_language_description ? String(r.payload.natural_language_description) : undefined,
			},
			metadata: { chunkType: r.payload?.chunk_type },
		}));
	}

	async purge(): Promise<void> {
		if (!this.initialized) throw new Error('Not initialized');
		await this.client.delete(this.collectionName, { wait: true, filter: this.configFilter(this.config.name || 'default') });
	}

	async getStats(): Promise<{ totalDocuments: number; totalChunks: number; storageSize?: number }> {
		if (!this.initialized) throw new Error('Not initialized');

		const [info, { count }] = await Promise.all([
			this.client.getCollection(this.collectionName),
			this.client.count(this.collectionName, { filter: this.configFilter(this.config.name || 'default'), exact: true }),
		]);

		return { totalDocuments: count, totalChunks: count, storageSize: info.points_count ?? undefined };
	}

	async isAvailable(): Promise<boolean> {
		try {
			await this.client.getCollections();
			return true;
		} catch {
			return false;
		}
	}

	async deleteCollection(): Promise<void> {
		await this.client.deleteCollection(this.collectionName);
		this.initialized = false;
		logger.info({ collectionName: this.collectionName }, 'Collection deleted');
	}
}
