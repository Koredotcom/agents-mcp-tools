import type { ProjectBuilderDomainOntology } from './contracts.js';
import { deepFreeze } from './contracts.js';

const QUALIFIED_ID = /^[a-z][a-z0-9-]*:[a-z][a-z0-9_-]*(?::[A-Za-z0-9._-]+)?$/;

export const CORE_ONTOLOGY: ProjectBuilderDomainOntology = deepFreeze({
  kinds: [
    { id: 'core:principal', label: 'Principal' },
    { id: 'core:project', label: 'Project' },
  ],
  edges: [{ id: 'core:owns', from: 'core:principal', to: 'core:project' }],
  lifecycle: [{ from: 'core:principal', to: 'core:project' }],
});

export function assertQualifiedId(id: string): void {
  if (!QUALIFIED_ID.test(id)) throw new Error(`ID must be qualified: ${id}`);
}

export function assertValidOntology(ontology: ProjectBuilderDomainOntology): void {
  const kindIds = uniqueIds(
    ontology.kinds.map(({ id }) => id),
    'resource kind',
  );
  uniqueIds(
    ontology.edges.map(({ id }) => id),
    'edge',
  );
  for (const id of [...kindIds, ...ontology.edges.map(({ id }) => id)]) assertQualifiedId(id);
  for (const edge of ontology.edges) {
    if (!kindIds.has(edge.from) || !kindIds.has(edge.to)) {
      throw new Error(`Edge ${edge.id} has a dangling resource kind`);
    }
  }
  for (const dependency of ontology.lifecycle) {
    if (!kindIds.has(dependency.from) || !kindIds.has(dependency.to)) {
      throw new Error('Lifecycle dependency has a dangling resource kind');
    }
  }
  topologicallySortKinds(ontology);
}

export function topologicallySortKinds(ontology: ProjectBuilderDomainOntology): string[] {
  const nodes = [...ontology.kinds.map(({ id }) => id)].sort();
  const indegree = new Map(nodes.map((id) => [id, 0]));
  const outgoing = new Map(nodes.map((id) => [id, [] as string[]]));
  for (const { from, to } of ontology.lifecycle) {
    if (!indegree.has(from) || !indegree.has(to))
      throw new Error('Lifecycle graph has a dangling kind');
    outgoing.get(from)!.push(to);
    indegree.set(to, indegree.get(to)! + 1);
  }
  for (const destinations of outgoing.values()) destinations.sort();
  const ready = nodes.filter((id) => indegree.get(id) === 0).sort();
  const result: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    result.push(id);
    for (const destination of outgoing.get(id)!) {
      const next = indegree.get(destination)! - 1;
      indegree.set(destination, next);
      if (next === 0) {
        ready.push(destination);
        ready.sort();
      }
    }
  }
  if (result.length !== nodes.length) throw new Error('Lifecycle graph contains a cycle');
  return result;
}

function uniqueIds(ids: readonly string[], label: string): Set<string> {
  const result = new Set<string>();
  for (const id of ids) {
    if (result.has(id)) throw new Error(`Duplicate ${label} ID: ${id}`);
    result.add(id);
  }
  return result;
}
