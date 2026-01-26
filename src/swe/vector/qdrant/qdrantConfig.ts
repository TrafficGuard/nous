import type { VectorStoreConfig } from '../core/config';

export interface QdrantConfig {
	url: string;
	apiKey?: string;
	collectionPrefix?: string;
	embeddingDimension: number;
	distanceFunction?: 'Cosine' | 'Euclid' | 'Dot' | 'Manhattan';
}

const DEFAULT_URL = 'http://localhost:6333';
const DEFAULT_PREFIX = 'code_chunks';

export function buildQdrantConfig(config: VectorStoreConfig, embeddingDimension: number): QdrantConfig {
	return {
		url: config.qdrant?.url || process.env.QDRANT_URL || DEFAULT_URL,
		apiKey: config.qdrant?.apiKey || process.env.QDRANT_API_KEY,
		collectionPrefix: config.qdrant?.collectionPrefix || DEFAULT_PREFIX,
		embeddingDimension,
		distanceFunction: config.qdrant?.distanceFunction || 'Cosine',
	};
}

export function sanitizeRepoName(repoIdentifier: string): string {
	let name = repoIdentifier
		.replace(/^https?:\/\//, '')
		.replace(/^git@/, '')
		.replace(/\.git$/, '')
		.replace(/github\.com[:/]/, '')
		.replace(/gitlab\.com[:/]/, '')
		.replace(/bitbucket\.org[:/]/, '')
		.replace(/[^a-zA-Z0-9_-]/g, '_')
		.replace(/[^a-zA-Z0-9]+$/, '')
		.toLowerCase();

	if (/^[^a-zA-Z]/.test(name)) name = `repo_${name}`;
	if (name.length > 45) name = name.substring(0, 45);
	if (name.length < 3) name = `${name}_repo`;

	return name;
}

export function getCollectionNameForRepo(repoIdentifier: string, prefix?: string): string {
	return `${prefix || DEFAULT_PREFIX}_${sanitizeRepoName(repoIdentifier)}`;
}
