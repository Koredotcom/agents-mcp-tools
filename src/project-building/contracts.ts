export const PROJECT_BUILDER_CONTRACT_VERSION = '1.1' as const;

export const PROJECT_BUILDER_LIMITS = Object.freeze({
  maxDepth: 12,
  maxArrayItems: 100,
  maxObjectKeys: 100,
  maxStringLength: 16_384,
  maxGraphNodes: 250,
  maxGraphEdges: 500,
  maxReferences: 200,
  maxEvidenceReferences: 100,
  maxPageSize: 100,
  maxPayloadBytes: 256 * 1024,
});

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ProjectBuilderNextAction {
  readonly action: string;
  readonly description: string;
}

export interface ProjectBuilderError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly nextActions: readonly ProjectBuilderNextAction[];
}

export interface ProjectBuilderEnvelope<T = unknown> {
  readonly schemaVersion: typeof PROJECT_BUILDER_CONTRACT_VERSION;
  readonly action: string;
  readonly success: boolean;
  readonly data: T | null;
  readonly error: ProjectBuilderError | null;
}

export interface ProjectBuilderToolResult<T = unknown> {
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }];
  readonly structuredContent: ProjectBuilderEnvelope<T>;
  readonly isError?: boolean;
}

export interface ProjectBuilderKind {
  readonly id: string;
  readonly label: string;
}

export interface ProjectBuilderEdgeKind {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

export interface ProjectBuilderLifecycleDependency {
  readonly from: string;
  readonly to: string;
}

export interface ProjectBuilderDomainOntology {
  readonly kinds: readonly ProjectBuilderKind[];
  readonly edges: readonly ProjectBuilderEdgeKind[];
  readonly lifecycle: readonly ProjectBuilderLifecycleDependency[];
}

export type ProjectBuilderActionMode =
  | 'read'
  | 'idempotent_write'
  | 'grant_gated_write'
  | 'destructive_write';

export interface ProjectBuilderActionDescriptor {
  readonly id: string;
  readonly mode: ProjectBuilderActionMode;
  readonly inputSchema: string;
  readonly outputSchema: string;
  readonly longRunning?: boolean;
}

export interface ProjectBuilderImport {
  readonly id: string;
  readonly required: boolean;
  readonly contractRange?: string;
}

export interface ProjectBuilderExport {
  readonly id: string;
  readonly kind: string;
}

export interface ProjectBuilderReadinessOwner {
  readonly kind: 'authoritative_service';
  readonly service: string;
  readonly supportsDependencyOnly: boolean;
  readonly assertions: readonly string[];
}

export interface ProjectBuilderRouteRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
}

export interface ProjectBuilderRouteAdapter {
  readonly supportedActions: readonly string[];
  buildRequest(
    action: string,
    request: {
      readonly projectId: string;
      readonly operationId?: string;
      readonly input?: unknown;
    },
  ): ProjectBuilderRouteRequest;
}

export interface ProjectBuilderDomainProvider {
  readonly domain: string;
  readonly contractVersion: typeof PROJECT_BUILDER_CONTRACT_VERSION;
  readonly ontology: ProjectBuilderDomainOntology;
  readonly actions: readonly ProjectBuilderActionDescriptor[];
  readonly inputSchemas: Readonly<Record<string, JsonSchema>>;
  readonly outputSchemas: Readonly<Record<string, JsonSchema>>;
  readonly imports: readonly ProjectBuilderImport[];
  readonly exports: readonly ProjectBuilderExport[];
  readonly readinessOwner: ProjectBuilderReadinessOwner;
  readonly routeAdapter: ProjectBuilderRouteAdapter;
}

export interface ProjectBuilderRegistryDescription {
  readonly contractVersion: typeof PROJECT_BUILDER_CONTRACT_VERSION;
  readonly coreKinds: readonly string[];
  readonly providers: readonly {
    readonly domain: string;
    readonly contractVersion: typeof PROJECT_BUILDER_CONTRACT_VERSION;
    readonly kinds: readonly string[];
    readonly actions: readonly string[];
    readonly imports: readonly ProjectBuilderImport[];
    readonly exports: readonly ProjectBuilderExport[];
    readonly readinessAssertions: readonly string[];
  }[];
}

export interface ProjectBuilderDomainRegistry {
  readonly providers: readonly ProjectBuilderDomainProvider[];
  getProvider(domain: string): ProjectBuilderDomainProvider;
  describe(domain?: string): ProjectBuilderRegistryDescription;
}

export interface BoundedValueOptions {
  readonly maxDepth?: number;
  readonly maxArrayItems?: number;
  readonly maxObjectKeys?: number;
  readonly maxStringLength?: number;
  readonly maxPayloadBytes?: number;
}

export function validateBoundedValue(value: unknown, options: BoundedValueOptions = {}): void {
  const limits = { ...PROJECT_BUILDER_LIMITS, ...options };
  const ancestors = new Set<object>();
  let estimatedBytes = 0;

  function visit(current: unknown, depth: number): void {
    if (depth > limits.maxDepth) throw new Error('Project-builder value exceeds maximum depth');
    if (typeof current === 'string') {
      if (current.length > limits.maxStringLength) {
        throw new Error('Project-builder string exceeds maximum length');
      }
      estimatedBytes += current.length * 2;
    } else if (typeof current === 'number' || typeof current === 'boolean') {
      estimatedBytes += 16;
    } else if (current !== null && typeof current === 'object') {
      if (ancestors.has(current)) throw new Error('Project-builder value is cyclic');
      ancestors.add(current);
      if (Array.isArray(current) && current.length > limits.maxArrayItems) {
        throw new Error('Project-builder array exceeds maximum items');
      }
      const entries = enumerableEntries(current, limits.maxObjectKeys);
      for (const [key, child] of entries) {
        estimatedBytes += key.length * 2;
        visit(child, depth + 1);
      }
      ancestors.delete(current);
    }
    if (estimatedBytes > limits.maxPayloadBytes) {
      throw new Error('Project-builder value exceeds maximum payload size');
    }
  }

  visit(value, 0);
}

export function createProjectBuilderResult<T>(action: string, data: T): ProjectBuilderToolResult<T>;
export function createProjectBuilderResult(
  action: string,
  data: null,
  error: ProjectBuilderError,
): ProjectBuilderToolResult<never>;
export function createProjectBuilderResult<T>(
  action: string,
  data: T | null,
  error: ProjectBuilderError | null = null,
): ProjectBuilderToolResult<T> {
  const envelope: ProjectBuilderEnvelope<T> = {
    schemaVersion: PROJECT_BUILDER_CONTRACT_VERSION,
    action,
    success: error === null,
    data,
    error,
  };
  validateBoundedValue(envelope);
  const text = JSON.stringify(envelope);
  return Object.freeze({
    content: Object.freeze([
      Object.freeze({ type: 'text' as const, text }),
    ]) as unknown as readonly [{ readonly type: 'text'; readonly text: string }],
    structuredContent: deepFreeze(envelope),
    ...(error ? { isError: true } : {}),
  });
}

export function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    deepFreeze((object as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

function enumerableEntries(value: object, maxEntries: number): Array<[string, unknown]> {
  if (Array.isArray(value)) return value.map((child, index) => [String(index), child]);
  const entries: Array<[string, unknown]> = [];
  if (value instanceof Error) {
    entries.push(['name', value.name], ['message', value.message]);
  }
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (value instanceof Error && (key === 'name' || key === 'message')) continue;
    if (entries.length >= maxEntries) {
      throw new Error('Project-builder object exceeds maximum keys');
    }
    try {
      entries.push([key, (value as Record<string, unknown>)[key]]);
    } catch {
      throw new Error(`Project-builder property cannot be read: ${key}`);
    }
  }
  if (entries.length > maxEntries) throw new Error('Project-builder object exceeds maximum keys');
  return entries;
}
