import * as fs from 'node:fs';
import * as path from 'node:path';
import { envVar } from '#utils/env-var';
import type { GoogleVectorServiceConfig } from '../google/googleVectorConfig';
import type { IVectorSearchOrchestrator } from './interfaces';

// === Nested Configuration Types ===

/**
 * Google Cloud configuration (shared across services)
 */
export interface GoogleCloudConfig {
	/** GCP project ID (overrides env GCLOUD_PROJECT) */
	projectId?: string;
	/** GCP region for embedding service (overrides env GCLOUD_REGION, default: 'us-central1') */
	region?: string;
}

/**
 * Discovery Engine configuration
 */
export interface DiscoveryEngineConfig {
	/** Discovery Engine location (default: 'global') */
	location?: string;
	/** Discovery Engine collection ID (default: 'default_collection') */
	collectionId?: string;
	/** Discovery Engine datastore ID */
	datastoreId?: string;
}

/**
 * AlloyDB configuration
 */
export interface AlloyDBNestedConfig {
	/** AlloyDB instance resource name (e.g., 'projects/PROJECT/locations/REGION/clusters/CLUSTER/instances/INSTANCE') */
	instance?: string;
	/** AlloyDB database name */
	database?: string;
	/** AlloyDB connection string (alternative to instance) */
	connectionString?: string;
	/** AlloyDB host (for direct connection) */
	host?: string;
	/** AlloyDB port (default: 5432) */
	port?: number;
	/** AlloyDB user */
	user?: string;
	/** AlloyDB password */
	password?: string;
	/** AlloyDB embedding model for automated embeddings (default: 'gemini-embedding-001') */
	embeddingModel?: string;
	/** Enable AlloyDB columnar engine for better filtered vector search (default: true) */
	enableColumnarEngine?: boolean;
	/** Hybrid search vector weight (0-1, text weight = 1 - vectorWeight, default: 0.7) */
	vectorWeight?: number;
}

/**
 * Ollama configuration (for local embedding)
 */
export interface OllamaNestedConfig {
	/** Ollama API URL (default: http://localhost:11434 or OLLAMA_API_URL env var) */
	apiUrl?: string;
	/** Ollama model for general/text embeddings (default: 'qwen3:8b') */
	embeddingModel?: string;
	/** Ollama model for code embeddings when using dual embedding (default: 'nomic-embed-code') */
	codeEmbeddingModel?: string;
}

/**
 * ChromaDB configuration (for local vector storage)
 */
export interface ChromaNestedConfig {
	/** ChromaDB server URL (default: http://localhost:8000 or CHROMA_URL env var) */
	url?: string;
	/** Authentication token (optional, for ChromaDB Cloud or authenticated servers) */
	authToken?: string;
	/** Tenant name (default: 'default_tenant') */
	tenant?: string;
	/** Database name (default: 'default_database') */
	database?: string;
	/** Collection name prefix (default: 'code_chunks') */
	collectionPrefix?: string;
	/** Distance function: 'cosine' | 'l2' | 'ip' (default: 'cosine') */
	distanceFunction?: 'cosine' | 'l2' | 'ip';
	/** Hybrid search text weight (0-1, vector weight = 1 - textWeight, default: 0.3) */
	textWeight?: number;
}

/**
 * Qdrant configuration (for vector storage)
 */
export interface QdrantNestedConfig {
	/** Qdrant server URL (default: http://localhost:6333 or QDRANT_URL env var) */
	url?: string;
	/** API key for Qdrant Cloud or authenticated servers (optional) */
	apiKey?: string;
	/** Collection name prefix (default: 'code_chunks') */
	collectionPrefix?: string;
	/** Distance function: 'Cosine' | 'Euclid' | 'Dot' (default: 'Cosine') */
	distanceFunction?: 'Cosine' | 'Euclid' | 'Dot';
}

/**
 * Embedding configuration
 */
export interface EmbeddingConfig {
	/** Embedding provider: 'vertex' | 'openai' | 'voyage' | 'cohere' | 'ollama' */
	provider?: string;
	/** Embedding model name (e.g., 'gemini-embedding-001', 'text-embedding-3-small') */
	model?: string;
}

/**
 * Chunking configuration
 *
 * NOTE: When contextualChunking is true, the LLM performs both chunking AND
 * contextualization in a single call, determining chunk boundaries semantically.
 * In this case, size/overlap/strategy are ignored and should be omitted.
 * These properties are only required when contextualChunking is false/undefined.
 */
export interface ChunkingConfig {
	/** Enable dual embedding (code + natural language translation) - ~12% better retrieval */
	dualEmbedding?: boolean;
	/** Enable contextual chunking (LLM-generated context) - ~49-67% better retrieval.
	 * When true, size/overlap/strategy are ignored (LLM determines chunk boundaries). */
	contextualChunking?: boolean;
	/** Chunk size in characters. Required when contextualChunking is false/undefined. */
	size?: number;
	/** Chunk overlap in characters. Required when contextualChunking is false/undefined. */
	overlap?: number;
	/** Chunking strategy. Required when contextualChunking is false/undefined.
	 * 'ast' = fast AST-based semantic chunking, 'llm' = slow LLM-based chunking */
	strategy?: 'ast' | 'llm';
}

/**
 * Reranking provider type
 */
export type RerankingProvider = 'vertex' | 'morphllm' | 'ollama';

/**
 * Reranking configuration
 * Presence of this object enables reranking
 */
export interface RerankingConfig {
	/** Reranking provider */
	provider: RerankingProvider;
	/** Model name (provider-specific defaults apply if not specified) */
	model?: string;
	/** Number of candidates to rerank (default: 50, max: 200) */
	topK?: number;
}

/**
 * Search configuration (defaults that can be overridden at search-time)
 */
export interface SearchConfig {
	/** Enable hybrid search (vector + BM25 lexical) */
	hybridSearch?: boolean;
	/** Reranking configuration - presence enables reranking */
	reranking?: RerankingConfig;
}

/**
 * Core vector store configuration for repository indexing
 */
export interface VectorStoreConfig {
	/** Name of the vector store collection (used to map to specific collections) */
	name?: string;

	/** Mark this config as the default when multiple configs exist (only one can be default) */
	default?: boolean;

	// === Google Cloud Configuration ===
	/** Google Cloud settings (shared across services) */
	googleCloud?: GoogleCloudConfig;

	// === Discovery Engine Configuration ===
	/** Discovery Engine settings */
	discoveryEngine?: DiscoveryEngineConfig;

	// === AlloyDB Configuration ===
	/** AlloyDB settings */
	alloydb?: AlloyDBNestedConfig;

	// === Ollama Configuration ===
	/** Ollama settings (for local embedding) */
	ollama?: OllamaNestedConfig;

	// === ChromaDB Configuration ===
	/** ChromaDB settings (for local vector storage) */
	chroma?: ChromaNestedConfig;

	// === Qdrant Configuration ===
	/** Qdrant settings (for vector search) */
	qdrant?: QdrantNestedConfig;

	// === Embedding Configuration ===
	/** Embedding settings */
	embedding?: EmbeddingConfig;

	// === Chunking Configuration ===
	/** Chunking settings */
	chunking?: ChunkingConfig;

	// === Search Configuration ===
	/** Search settings (defaults, can be overridden at search-time) */
	search?: SearchConfig;

	// === File Selection ===
	/** File/directory patterns to include (glob patterns, e.g., ['src/**', 'lib/**']) */
	includePatterns?: string[];

	/** Maximum file size in bytes to index (default: 1MB) */
	maxFileSize?: number;

	/** Supported file extensions to index */
	fileExtensions?: string[];

	// === Debug/Misc ===
	/** Log contextualized chunks to .typedai/vector/chunks/ for debugging (default: false) */
	logChunks?: boolean;

	/** Whether the repository has been indexed for vector search (default: false) */
	indexed?: boolean;
}

/**
 * Default configuration - fast and cost-effective
 */
export const DEFAULT_VECTOR_CONFIG: VectorStoreConfig = {
	embedding: {
		provider: 'vertex',
		model: 'gemini-embedding-001',
	},
	chunking: {
		dualEmbedding: false,
		contextualChunking: false,
		size: 2500,
		overlap: 300,
		strategy: 'ast',
	},
	search: {
		hybridSearch: true,
	},
	maxFileSize: 1024 * 1024, // 1MB
	fileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.cpp', '.c', '.h', '.go', '.rs', '.rb', '.php', '.cs', '.swift', '.kt'],
	logChunks: false,
};

/**
 * High quality configuration - enables all quality features
 */
export const HIGH_QUALITY_CONFIG: VectorStoreConfig = {
	...DEFAULT_VECTOR_CONFIG,
	chunking: {
		dualEmbedding: true,
		contextualChunking: true,
		size: 2500,
		overlap: 300,
		strategy: 'ast',
	},
	search: {
		hybridSearch: true,
		reranking: {
			provider: 'vertex',
			model: 'semantic-ranker-default@latest',
			topK: 50,
		},
	},
};

import { type VectorBackend, buildBackendConfig, requireBackend } from './autoDetect';
import { type RepositoryVectorConfig, getPreset, listPresets } from './presets';

/**
 * Deep merge two objects, with source values taking precedence
 * Only merges plain objects, not arrays or other types
 */
function deepMerge<T>(target: T, source: Partial<T>): T {
	const result = { ...target } as T;
	for (const key of Object.keys(source) as (keyof T)[]) {
		const sourceValue = source[key];
		const targetValue = target[key];
		if (
			sourceValue !== undefined &&
			sourceValue !== null &&
			typeof sourceValue === 'object' &&
			!Array.isArray(sourceValue) &&
			targetValue !== undefined &&
			targetValue !== null &&
			typeof targetValue === 'object' &&
			!Array.isArray(targetValue)
		) {
			// Deep merge nested objects
			result[key] = deepMerge(targetValue as Record<string, unknown>, sourceValue as Record<string, unknown>) as T[keyof T];
		} else if (sourceValue !== undefined) {
			// Overwrite with source value
			result[key] = sourceValue as T[keyof T];
		}
	}
	return result;
}

/**
 * Resolve a product repo's minimal config into a full VectorStoreConfig
 *
 * @param productConfig - Minimal config from product repo's .typedai.json
 * @returns Fully resolved VectorStoreConfig
 */
export function resolveProductConfig(productConfig: RepositoryVectorConfig): VectorStoreConfig {
	// 1. Get preset from registry
	const preset = getPreset(productConfig.preset);

	// 2. Auto-detect or use explicit backend
	let backendConfig: Partial<VectorStoreConfig>;
	if (productConfig.backend) {
		backendConfig = buildBackendConfig(productConfig.backend);
	} else {
		const detection = requireBackend();
		backendConfig = detection.config;
	}

	// 3. Merge: preset <- backend config <- overrides <- includePatterns
	// Use deep merge to properly combine nested objects like googleCloud and discoveryEngine
	let config: VectorStoreConfig = { ...preset };
	config = deepMerge(config, backendConfig);
	config = deepMerge(config, productConfig.overrides || {});
	config.includePatterns = productConfig.includePatterns;
	config.name = productConfig.name;

	// Remove preset registry fields (those are for identification, not runtime)
	config.default = undefined;

	return config;
}

/**
 * Load vector config from product repo's .typedai.json
 * Resolves preset references and auto-detects backend
 *
 * @param repoRoot - Repository root path
 * @param configName - Optional config name when using array of vector configs
 * @returns Fully resolved VectorStoreConfig
 */
export function loadVectorConfig(repoRoot: string, configName?: string): VectorStoreConfig {
	const typedaiPath = path.join(repoRoot, '.typedai.json');
	if (!fs.existsSync(typedaiPath)) {
		throw new Error(
			`No .typedai.json found in ${repoRoot}.\nCreate one with a "vector" property:\n  [{ "baseDir": "./", "vector": { "preset": "<preset-name>", "includePatterns": ["src/**"] } }]`,
		);
	}

	const content = JSON.parse(fs.readFileSync(typedaiPath, 'utf-8'));
	const projects = Array.isArray(content) ? content : [content];
	const project = projects.find((p: Record<string, unknown>) => p.primary) || projects[0];

	if (!project?.vector) {
		throw new Error(`No "vector" property found in .typedai.json.\n` + `Add: "vector": { "preset": "<preset-name>", "includePatterns": ["src/**"] }`);
	}

	// Handle array of vector configs
	const vectorConfigs = Array.isArray(project.vector) ? project.vector : [project.vector];

	// Find the right config
	let productConfig: RepositoryVectorConfig;
	if (configName) {
		const found = vectorConfigs.find((c: RepositoryVectorConfig) => c.name === configName);
		if (!found) {
			const available = vectorConfigs
				.map((c: RepositoryVectorConfig) => c.name)
				.filter(Boolean)
				.join(', ');
			throw new Error(`Vector config "${configName}" not found. Available: ${available || '(unnamed)'}`);
		}
		productConfig = found;
	} else {
		// Use default or first
		productConfig = vectorConfigs.find((c: RepositoryVectorConfig) => c.default) || vectorConfigs[0];
	}

	if (!productConfig.preset) {
		throw new Error(`Missing "preset" in vector config.\nAvailable presets: ${listPresets().join(', ')}`);
	}

	return resolveProductConfig(productConfig);
}

/**
 * Load all vector configs from product repo's .typedai.json
 * Returns array of all resolved configs
 *
 * @param repoRoot - Repository root path
 * @returns Array of fully resolved VectorStoreConfig
 */
export function loadAllVectorConfigs(repoRoot: string): VectorStoreConfig[] {
	const typedaiPath = path.join(repoRoot, '.typedai.json');
	if (!fs.existsSync(typedaiPath)) {
		throw new Error(`No .typedai.json found in ${repoRoot}`);
	}

	const content = JSON.parse(fs.readFileSync(typedaiPath, 'utf-8'));
	const projects = Array.isArray(content) ? content : [content];
	const project = projects.find((p: Record<string, unknown>) => p.primary) || projects[0];

	if (!project?.vector) {
		throw new Error(`No "vector" property found in .typedai.json`);
	}

	const vectorConfigs = Array.isArray(project.vector) ? project.vector : [project.vector];
	return vectorConfigs.map((productConfig: RepositoryVectorConfig) => resolveProductConfig(productConfig));
}

/**
 * Save vector store configuration to repository
 * @param repoRoot - Repository root path
 * @param config - Single config or array of configs to save
 */
export function saveVectorConfig(repoRoot: string, config: VectorStoreConfig | VectorStoreConfig[]): void {
	const vectorConfigPath = path.join(repoRoot, '.vectorconfig.json');
	fs.writeFileSync(vectorConfigPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Add or update a vector store configuration in the config file
 * @param repoRoot - Repository root path
 * @param config - Config to add or update (matched by name)
 */
export function addOrUpdateVectorConfig(repoRoot: string, config: VectorStoreConfig): void {
	const configs = loadAllVectorConfigs(repoRoot);

	if (!config.name) {
		// If no name, replace the entire config with a single config
		saveVectorConfig(repoRoot, config);
		return;
	}

	// Find existing config by name
	const existingIndex = configs.findIndex((c) => c.name === config.name);

	if (existingIndex >= 0) {
		// Update existing config
		configs[existingIndex] = { ...configs[existingIndex], ...config };
	} else {
		// Add new config
		configs.push(config);
	}

	saveVectorConfig(repoRoot, configs);
}

/**
 * Validate vector store configuration
 */
export function validateVectorConfig(config: VectorStoreConfig): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	if (config.name !== undefined) {
		if (typeof config.name !== 'string' || config.name.trim() === '') {
			errors.push('name must be a non-empty string');
		}
		// Validate name format (alphanumeric, dash, underscore)
		if (config.name && !/^[a-zA-Z0-9_-]+$/.test(config.name)) {
			errors.push('name must contain only alphanumeric characters, dashes, and underscores');
		}
	}

	// Google Cloud configuration validation
	if (config.googleCloud?.projectId !== undefined && config.googleCloud.projectId.trim() === '') {
		errors.push('googleCloud.projectId must be a non-empty string');
	}

	if (config.googleCloud?.region !== undefined && config.googleCloud.region.trim() === '') {
		errors.push('googleCloud.region must be a non-empty string');
	}

	// Discovery Engine configuration validation
	if (config.discoveryEngine?.datastoreId !== undefined && config.discoveryEngine.datastoreId.trim() === '') {
		errors.push('discoveryEngine.datastoreId must be a non-empty string');
	}

	if (config.discoveryEngine?.location !== undefined) {
		const validLocations = ['global', 'us', 'eu'];
		if (!validLocations.includes(config.discoveryEngine.location)) {
			errors.push(`discoveryEngine.location must be one of: ${validLocations.join(', ')}`);
		}
	}

	if (config.discoveryEngine?.collectionId !== undefined && config.discoveryEngine.collectionId.trim() === '') {
		errors.push('discoveryEngine.collectionId must be a non-empty string');
	}

	// AlloyDB configuration validation
	if (config.alloydb?.vectorWeight !== undefined && (config.alloydb.vectorWeight < 0 || config.alloydb.vectorWeight > 1)) {
		errors.push('alloydb.vectorWeight must be between 0 and 1');
	}

	// Embedding configuration validation
	if (config.embedding?.provider !== undefined) {
		const validProviders = ['vertex', 'openai', 'voyage', 'cohere', 'ollama'];
		if (!validProviders.includes(config.embedding.provider)) {
			errors.push(`embedding.provider must be one of: ${validProviders.join(', ')}`);
		}
	}

	if (config.embedding?.model !== undefined && config.embedding.model.trim() === '') {
		errors.push('embedding.model must be a non-empty string');
	}

	// Chunking validation
	// When contextualChunking is false/undefined, size/overlap/strategy are required
	// (LLM contextual chunking determines its own chunk boundaries)
	const usesManualChunking = !config.chunking?.contextualChunking;
	if (usesManualChunking && config.chunking) {
		if (config.chunking.size === undefined) {
			errors.push('chunking.size is required when contextualChunking is false/undefined');
		}
		if (config.chunking.overlap === undefined) {
			errors.push('chunking.overlap is required when contextualChunking is false/undefined');
		}
		if (config.chunking.strategy === undefined) {
			errors.push('chunking.strategy is required when contextualChunking is false/undefined');
		}
	}

	if (config.chunking?.size !== undefined && config.chunking.size < 100) {
		errors.push('chunking.size must be at least 100 characters');
	}

	if (config.chunking?.size !== undefined && config.chunking.size > 10000) {
		errors.push('chunking.size should not exceed 10000 characters');
	}

	if (config.chunking?.overlap !== undefined && config.chunking.overlap < 0) {
		errors.push('chunking.overlap must be non-negative');
	}

	if (config.chunking?.overlap && config.chunking?.size && config.chunking.overlap >= config.chunking.size) {
		errors.push('chunking.overlap must be less than chunking.size');
	}

	if (config.chunking?.strategy && !['ast', 'llm'].includes(config.chunking.strategy)) {
		errors.push("chunking.strategy must be 'ast' or 'llm'");
	}

	// Search configuration validation
	if (config.search?.reranking !== undefined) {
		const reranking = config.search.reranking;
		const validProviders: RerankingProvider[] = ['vertex', 'morphllm', 'ollama'];
		if (!validProviders.includes(reranking.provider)) {
			errors.push(`search.reranking.provider must be one of: ${validProviders.join(', ')}`);
		}
		if (reranking.model !== undefined && reranking.model.trim() === '') {
			errors.push('search.reranking.model must be a non-empty string');
		}
		if (reranking.topK !== undefined && (reranking.topK < 1 || reranking.topK > 200)) {
			errors.push('search.reranking.topK must be between 1 and 200');
		}
	}

	if (config.maxFileSize && config.maxFileSize < 1024) {
		errors.push('maxFileSize must be at least 1KB');
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

/**
 * Validate array of vector store configurations
 * Checks for duplicate names, validates each config, and ensures only one default
 */
export function validateVectorConfigs(configs: VectorStoreConfig[]): { valid: boolean; errors: string[] } {
	const errors: string[] = [];
	const names = new Set<string>();

	for (const config of configs) {
		// Validate individual config
		const configValidation = validateVectorConfig(config);
		if (!configValidation.valid) {
			errors.push(...configValidation.errors.map((e) => `Config "${config.name || 'unnamed'}": ${e}`));
		}

		// Check for duplicate names
		if (config.name) {
			if (names.has(config.name)) {
				errors.push(`Duplicate config name: "${config.name}"`);
			}
			names.add(config.name);
		}
	}

	// If there are multiple configs, all should have names
	if (configs.length > 1) {
		const unnamedConfigs = configs.filter((c) => !c.name);
		if (unnamedConfigs.length > 0) {
			errors.push(`When using multiple configs, all configs must have a "name" property (${unnamedConfigs.length} unnamed config(s) found)`);
		}

		// Check that only one config has default: true
		const defaultConfigs = configs.filter((c) => c.default === true);
		if (defaultConfigs.length > 1) {
			const defaultNames = defaultConfigs.map((c) => c.name || 'unnamed').join(', ');
			errors.push(`Only one config can have "default: true" (found ${defaultConfigs.length}: ${defaultNames})`);
		}

		// Warn if no default is set (not an error, just informational - first config will be used)
		if (defaultConfigs.length === 0) {
			// This is allowed - first config becomes default
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

/**
 * Build GoogleVectorServiceConfig from VectorStoreConfig + environment variables
 * Config values override environment variables
 *
 * @param config VectorStoreConfig with optional GCP settings
 * @returns GoogleVectorServiceConfig for Google Cloud services
 */
export function buildGoogleVectorServiceConfig(config: VectorStoreConfig): GoogleVectorServiceConfig {
	return {
		project: config.googleCloud?.projectId || envVar('GCLOUD_PROJECT'),
		region: config.googleCloud?.region || envVar('GCLOUD_REGION', 'us-central1'),
		discoveryEngineLocation: config.discoveryEngine?.location || envVar('DISCOVERY_ENGINE_LOCATION', 'global'),
		collection: config.discoveryEngine?.collectionId || envVar('DISCOVERY_ENGINE_COLLECTION_ID', 'default_collection'),
		dataStoreId: config.discoveryEngine?.datastoreId || envVar('DISCOVERY_ENGINE_DATA_STORE_ID', 'test-datastore'),
		embeddingModel: config.embedding?.model || process.env.DISCOVERY_ENGINE_EMBEDDING_MODEL || 'gemini-embedding-001',
	};
}

/**
 * Get estimated cost per file based on configuration
 * Returns cost estimate in USD
 */
export function estimateCostPerFile(config: VectorStoreConfig, avgFileSize = 5000): number {
	let cost = 0;

	// Base embedding cost (~$0.00001 per 1K tokens)
	const tokensPerFile = avgFileSize / 4; // rough estimate: 4 chars per token
	cost += (tokensPerFile / 1000) * 0.00001;

	// Dual embedding doubles the embedding cost
	if (config.chunking?.dualEmbedding) {
		cost += (tokensPerFile / 1000) * 0.00001; // code-to-english translation
		cost += (tokensPerFile / 1000) * 0.00001; // second embedding
	}

	// Contextual chunking adds LLM cost
	if (config.chunking?.contextualChunking) {
		// Assume 5 chunks per file, each needing context generation
		const chunksPerFile = 5;
		const tokensPerContextGeneration = avgFileSize + 100; // full file + context prompt
		cost += ((chunksPerFile * tokensPerContextGeneration) / 1000) * 0.00001;
	}

	return cost;
}

/**
 * Print configuration summary
 */
export function printConfigSummary(config: VectorStoreConfig): void {
	console.log('Vector Store Configuration:');
	console.log('━'.repeat(50));
	console.log(`  Dual Embedding: ${config.chunking?.dualEmbedding ? '✓ Enabled' : '✗ Disabled'}`);
	console.log(`  Contextual Chunking: ${config.chunking?.contextualChunking ? '✓ Enabled' : '✗ Disabled'}`);
	console.log(`  Chunk Strategy: ${config.chunking?.strategy || 'ast'}`);
	console.log(`  Chunk Size: ${config.chunking?.size || 2500} chars`);
	console.log(`  Chunk Overlap: ${config.chunking?.overlap || 300} chars`);
	console.log(`  Embedding Provider: ${config.embedding?.provider || 'vertex'}`);
	console.log(`  Embedding Model: ${config.embedding?.model || 'gemini-embedding-001'}`);
	console.log(`  Hybrid Search: ${config.search?.hybridSearch ? '✓ Enabled' : '✗ Disabled'}`);
	const rerankConfig = config.search?.reranking;
	console.log(`  Reranking: ${rerankConfig ? '✓ Enabled' : '✗ Disabled'}`);
	if (rerankConfig) {
		console.log(`  Reranking Provider: ${rerankConfig.provider}`);
		console.log(`  Reranking Model: ${rerankConfig.model || '(default)'}`);
	}
	console.log('━'.repeat(50));

	// Show quality and cost estimates
	const quality = (config.chunking?.dualEmbedding ? 12 : 0) + (config.chunking?.contextualChunking ? 60 : 0);
	const costMultiplier = 1 + (config.chunking?.dualEmbedding ? 2 : 0) + (config.chunking?.contextualChunking ? 5 : 0);

	console.log(`  Estimated Quality Improvement: ~${quality}%`);
	console.log(`  Estimated Cost Multiplier: ${costMultiplier}x`);
	console.log(`  Estimated Cost per File: ~$${estimateCostPerFile(config).toFixed(6)}`);
	console.log('━'.repeat(50));
}

/**
 * Check if vector search is available for a repository
 * Returns true if .vectorconfig.json exists AND indexed is true
 */
export function isVectorSearchAvailable(repoRoot: string): boolean {
	try {
		return loadVectorConfig(repoRoot).indexed === true;
	} catch {
		return false;
	}
}

/**
 * Create a vector search orchestrator for the given repository
 * Returns null if vector search is not available or configuration is invalid
 */
export async function createVectorOrchestrator(repoRoot: string): Promise<IVectorSearchOrchestrator | null> {
	try {
		const config = loadVectorConfig(repoRoot);
		if (!config.indexed) return null;

		// Determine backend based on config
		if (config.qdrant?.url) {
			// Use Qdrant - dynamic import to avoid loading when not needed
			const { buildQdrantConfig, QdrantOrchestrator } = await import('../qdrant/index.js');
			return new QdrantOrchestrator(repoRoot, config);
		}

		if (config.chroma?.url) {
			// Use ChromaDB - dynamic import to avoid loading when not needed
			const { ChromaOrchestrator } = await import('../chroma/index.js');
			return new ChromaOrchestrator(repoRoot, config);
		}

		if (config.alloydb?.host || config.alloydb?.instance) {
			// Use AlloyDB - dynamic import to avoid loading when not needed
			const { buildAlloyDBConfig, AlloyDBOrchestrator } = await import('../alloydb/index.js');
			const alloydbConfig = buildAlloyDBConfig(config);
			return new AlloyDBOrchestrator(repoRoot, alloydbConfig, config);
		}

		// Default to Discovery Engine - dynamic import to avoid loading when not needed
		const { VectorSearchOrchestrator } = await import('../index.js');
		const googleConfig = buildGoogleVectorServiceConfig(config);
		return new VectorSearchOrchestrator(googleConfig, config);
	} catch (error) {
		console.warn('Failed to create vector orchestrator:', error);
		return null;
	}
}
