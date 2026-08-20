import {
  PROJECT_BUILDER_CONTRACT_VERSION,
  deepFreeze,
  type ProjectBuilderDomainProvider,
  type ProjectBuilderDomainRegistry,
  type ProjectBuilderRegistryDescription,
} from './contracts.js';
import { CORE_ONTOLOGY, assertQualifiedId, assertValidOntology } from './ontology.js';
import { createWorkflowDomainProvider } from './domains/workflow.js';

const DOMAIN_ID = /^[a-z][a-z0-9-]*$/;
const RESERVED_DOMAINS = new Set(['core', 'project']);

export function createProjectBuilderDomainRegistry(
  inputProviders: readonly ProjectBuilderDomainProvider[],
): ProjectBuilderDomainRegistry {
  const providers = inputProviders
    .map(cloneProvider)
    .sort((left, right) => left.domain.localeCompare(right.domain));
  validateProviders(providers);
  const byDomain = new Map(providers.map((provider) => [provider.domain, provider]));

  const describe = (domain?: string): ProjectBuilderRegistryDescription => {
    const selected = domain ? [getProvider(domain)] : providers;
    return deepFreeze({
      contractVersion: PROJECT_BUILDER_CONTRACT_VERSION,
      coreKinds: CORE_ONTOLOGY.kinds.map(({ id }) => id).sort(),
      providers: selected.map((provider) => ({
        domain: provider.domain,
        contractVersion: provider.contractVersion,
        kinds: provider.ontology.kinds.map(({ id }) => id).sort(),
        actions: provider.actions.map(({ id }) => id).sort(),
        imports: [...provider.imports].sort(byId),
        exports: [...provider.exports].sort(byId),
        readinessAssertions: [...provider.readinessOwner.assertions].sort(),
      })),
    });
  };
  const getProvider = (domain: string): ProjectBuilderDomainProvider => {
    const provider = byDomain.get(domain);
    if (!provider) throw new Error(`Unsupported project-builder domain: ${domain}`);
    return provider;
  };
  return deepFreeze({ providers: deepFreeze(providers), getProvider, describe });
}

export function createProductionProjectBuilderDomainRegistry(): ProjectBuilderDomainRegistry {
  return createProjectBuilderDomainRegistry([createWorkflowDomainProvider()]);
}

function validateProviders(providers: readonly ProjectBuilderDomainProvider[]): void {
  const domains = new Set<string>();
  const exports = new Map<string, string>();
  const readinessOwners = new Map<string, string>();
  for (const provider of providers) {
    if (!DOMAIN_ID.test(provider.domain) || RESERVED_DOMAINS.has(provider.domain)) {
      throw new Error(`Provider domain is invalid or reserved: ${provider.domain}`);
    }
    if (domains.has(provider.domain))
      throw new Error(`Duplicate provider domain: ${provider.domain}`);
    domains.add(provider.domain);
    if (provider.contractVersion !== PROJECT_BUILDER_CONTRACT_VERSION) {
      throw new Error(`Incompatible provider contract: ${provider.contractVersion}`);
    }
    assertValidOntology(provider.ontology);
    for (const kind of provider.ontology.kinds) assertOwnedId(kind.id, provider.domain, 'kind');
    const kindIds = new Set(provider.ontology.kinds.map(({ id }) => id));
    const supported = new Set(provider.routeAdapter.supportedActions);
    for (const action of provider.actions) {
      assertOwnedId(action.id, provider.domain, 'action');
      if (
        !provider.inputSchemas[action.inputSchema] ||
        !provider.outputSchemas[action.outputSchema]
      ) {
        throw new Error(`Action ${action.id} is missing its advertised schema`);
      }
      if (
        !supported.has(action.id) &&
        !supported.has(action.id.slice(provider.domain.length + 1))
      ) {
        throw new Error(`Action ${action.id} has no route adapter`);
      }
    }
    if (provider.actions.length > 0 && provider.readinessOwner.assertions.length === 0) {
      throw new Error(`Provider ${provider.domain} has actions without readiness ownership`);
    }
    for (const exported of provider.exports) {
      assertQualifiedId(exported.id);
      if (!kindIds.has(exported.kind)) throw new Error(`Export ${exported.id} has unknown kind`);
      const owner = exports.get(exported.id);
      if (owner)
        throw new Error(`Duplicate export ${exported.id} from ${owner} and ${provider.domain}`);
      exports.set(exported.id, provider.domain);
    }
    for (const assertion of provider.readinessOwner.assertions) {
      assertQualifiedId(assertion);
      const owner = readinessOwners.get(assertion);
      if (owner) throw new Error(`Duplicate readiness owner for ${assertion}: ${owner}`);
      readinessOwners.set(assertion, provider.domain);
    }
  }
  for (const provider of providers) {
    for (const imported of provider.imports) {
      assertQualifiedId(imported.id);
      if (
        imported.contractRange &&
        imported.contractRange !== '^1.1' &&
        imported.contractRange !== '1.1'
      ) {
        throw new Error(`Incompatible import contract range: ${imported.contractRange}`);
      }
      if (imported.required && !exports.has(imported.id)) {
        throw new Error(`Dangling required import: ${imported.id}`);
      }
    }
  }
}

function assertOwnedId(id: string, domain: string, label: string): void {
  assertQualifiedId(id);
  if (!id.startsWith(`${domain}:`)) throw new Error(`${label} ${id} is outside domain ${domain}`);
}

function cloneProvider(provider: ProjectBuilderDomainProvider): ProjectBuilderDomainProvider {
  return deepFreeze({
    ...provider,
    ontology: {
      kinds: provider.ontology.kinds.map((kind) => ({ ...kind })).sort(byId),
      edges: provider.ontology.edges.map((edge) => ({ ...edge })).sort(byId),
      lifecycle: provider.ontology.lifecycle
        .map((dependency) => ({ ...dependency }))
        .sort((left, right) =>
          `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`),
        ),
    },
    actions: provider.actions.map((action) => ({ ...action })).sort(byId),
    inputSchemas: cloneRecord(provider.inputSchemas),
    outputSchemas: cloneRecord(provider.outputSchemas),
    imports: provider.imports.map((value) => ({ ...value })).sort(byId),
    exports: provider.exports.map((value) => ({ ...value })).sort(byId),
    readinessOwner: {
      ...provider.readinessOwner,
      assertions: [...provider.readinessOwner.assertions].sort(),
    },
    routeAdapter: {
      supportedActions: [...provider.routeAdapter.supportedActions].sort(),
      buildRequest: provider.routeAdapter.buildRequest,
    },
  });
}

function cloneRecord<T>(record: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function byId(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id.localeCompare(right.id);
}
