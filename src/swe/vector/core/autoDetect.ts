import type { AlloyDBNestedConfig, ChromaNestedConfig, DiscoveryEngineConfig, GoogleCloudConfig, QdrantNestedConfig, VectorStoreConfig } from './config';

export type VectorBackend = 'alloydb' | 'discovery-engine' | 'chroma' | 'qdrant';

export interface BackendDetection {
	backend: VectorBackend | null;
	reason: string;
	config: Partial<VectorStoreConfig>;
}

/**
 * Auto-detect available vector backend from environment variables
 *
 * Detection Priority:
 * 1. ChromaDB - CHROMA_URL (local-first, most common for development)
 * 2. AlloyDB - ALLOYDB_HOST or PGHOST
 * 3. Discovery Engine - GCLOUD_PROJECT
 * 4. null - No backend detected
 */
export function detectBackend(): BackendDetection {
	// 1. Check for Qdrant
	const qdrantUrl = process.env.QDRANT_URL;
	if (qdrantUrl) {
		const qdrant: QdrantNestedConfig = {
			url: qdrantUrl,
			apiKey: process.env.QDRANT_API_KEY,
		};

		return {
			backend: 'qdrant',
			reason: 'Qdrant detected via QDRANT_URL',
			config: {
				qdrant,
				embedding: {
					provider: 'ollama',
					model: process.env.OLLAMA_EMBEDDING_MODEL || 'manutic/nomic-embed-code',
				},
			},
		};
	}

	// 2. Check for ChromaDB (local-first)
	const chromaUrl = process.env.CHROMA_URL;
	if (chromaUrl) {
		const chroma: ChromaNestedConfig = {
			url: chromaUrl,
			authToken: process.env.CHROMA_AUTH_TOKEN,
			tenant: process.env.CHROMA_TENANT || 'default_tenant',
			database: process.env.CHROMA_DATABASE || 'default_database',
		};

		return {
			backend: 'chroma',
			reason: 'ChromaDB detected via CHROMA_URL',
			config: {
				chroma,
				embedding: {
					provider: 'ollama',
					model: process.env.OLLAMA_EMBEDDING_MODEL || 'manutic/nomic-embed-code',
				},
			},
		};
	}

	// 3. Check for AlloyDB/Postgres
	const pgHost = process.env.ALLOYDB_HOST || process.env.PGHOST;
	if (pgHost) {
		const alloydb: AlloyDBNestedConfig = {
			host: pgHost,
			port: Number.parseInt(process.env.ALLOYDB_PORT || process.env.PGPORT || '5432', 10),
			database: process.env.ALLOYDB_DATABASE || process.env.PGDATABASE || 'vectors',
			user: process.env.ALLOYDB_USER || process.env.PGUSER || 'postgres',
			password: process.env.ALLOYDB_PASSWORD || process.env.PGPASSWORD,
		};

		return {
			backend: 'alloydb',
			reason: `AlloyDB detected via ${process.env.ALLOYDB_HOST ? 'ALLOYDB_HOST' : 'PGHOST'}`,
			config: { alloydb },
		};
	}

	// 4. Check for Discovery Engine
	const gcpProject = process.env.GCLOUD_PROJECT;
	if (gcpProject) {
		const googleCloud: GoogleCloudConfig = {
			projectId: gcpProject,
			region: process.env.GCLOUD_REGION || 'us-central1',
		};

		const discoveryEngine: DiscoveryEngineConfig = {
			location: process.env.DISCOVERY_ENGINE_LOCATION || 'global',
			collectionId: process.env.DISCOVERY_ENGINE_COLLECTION_ID || 'default_collection',
			datastoreId: process.env.DISCOVERY_ENGINE_DATA_STORE_ID,
		};

		return {
			backend: 'discovery-engine',
			reason: 'Discovery Engine detected via GCLOUD_PROJECT',
			config: { googleCloud, discoveryEngine },
		};
	}

	// 5. No backend detected
	return {
		backend: null,
		reason: 'No backend detected',
		config: {},
	};
}

/**
 * Require a backend to be detected, throw error if not
 */
export function requireBackend(): BackendDetection {
	const detection = detectBackend();
	if (!detection.backend) {
		throw new Error(
			'No vector backend detected. Set one of:\n' +
				'  - QDRANT_URL (for Qdrant + Ollama, local development)\n' +
				'  - CHROMA_URL (for ChromaDB + Ollama, local development)\n' +
				'  - ALLOYDB_HOST or PGHOST (for AlloyDB/Postgres)\n' +
				'  - GCLOUD_PROJECT (for Discovery Engine)',
		);
	}
	return detection;
}

/**
 * Build backend-specific config based on explicit backend choice
 */
export function buildBackendConfig(backend: VectorBackend): Partial<VectorStoreConfig> {
	switch (backend) {
		case 'qdrant': {
			const qdrant: QdrantNestedConfig = {
				url: process.env.QDRANT_URL || 'http://localhost:6333',
				apiKey: process.env.QDRANT_API_KEY,
			};
			return {
				qdrant,
				embedding: {
					provider: 'ollama',
					model: process.env.OLLAMA_EMBEDDING_MODEL || 'manutic/nomic-embed-code',
				},
			};
		}
		case 'chroma': {
			const chroma: ChromaNestedConfig = {
				url: process.env.CHROMA_URL || 'http://localhost:8000',
				authToken: process.env.CHROMA_AUTH_TOKEN,
				tenant: process.env.CHROMA_TENANT || 'default_tenant',
				database: process.env.CHROMA_DATABASE || 'default_database',
			};
			return {
				chroma,
				embedding: {
					provider: 'ollama',
					model: process.env.OLLAMA_EMBEDDING_MODEL || 'manutic/nomic-embed-code',
				},
			};
		}
		case 'alloydb': {
			const alloydb: AlloyDBNestedConfig = {
				host: process.env.ALLOYDB_HOST || process.env.PGHOST,
				port: Number.parseInt(process.env.ALLOYDB_PORT || process.env.PGPORT || '5432', 10),
				database: process.env.ALLOYDB_DATABASE || process.env.PGDATABASE || 'vectors',
				user: process.env.ALLOYDB_USER || process.env.PGUSER || 'postgres',
				password: process.env.ALLOYDB_PASSWORD || process.env.PGPASSWORD,
			};
			return { alloydb };
		}
		case 'discovery-engine': {
			const googleCloud: GoogleCloudConfig = {
				projectId: process.env.GCLOUD_PROJECT,
				region: process.env.GCLOUD_REGION || 'us-central1',
			};
			const discoveryEngine: DiscoveryEngineConfig = {
				location: process.env.DISCOVERY_ENGINE_LOCATION || 'global',
				collectionId: process.env.DISCOVERY_ENGINE_COLLECTION_ID || 'default_collection',
				datastoreId: process.env.DISCOVERY_ENGINE_DATA_STORE_ID,
			};
			return { googleCloud, discoveryEngine };
		}
		default:
			throw new Error(`Unknown backend: ${backend}`);
	}
}
