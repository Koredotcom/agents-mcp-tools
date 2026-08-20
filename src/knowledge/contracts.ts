import type { ArchCapability } from '../tools/persona.js';

export const ARCH_KNOWLEDGE_SCHEMA_VERSION = '1' as const;
export const ARCH_KNOWLEDGE_MEDIA_TYPE =
  'application/vnd.kore.arch-mcp-knowledge+json;version=1' as const;

export const ARCH_KNOWLEDGE_LIMITS = Object.freeze({
  maxIndexBytes: 256 * 1024,
  maxDetailBytes: 64 * 1024,
  maxFeatures: 64,
  maxTools: 128,
  maxOperations: 512,
  maxDependencies: 256,
});

export type KnowledgeSupport = 'verified' | 'implemented' | 'documented' | 'unsupported';
export type DependencyAuthority = 'authoritative-live' | 'code-corroborated';
export type DependencyKind = 'requires' | 'produces' | 'consumes' | 'optional';
export type OperationScope = 'global' | 'tenant' | 'workspace' | 'project' | 'operation';
export type OperationSafety =
  | 'read'
  | 'write'
  | 'idempotent_write'
  | 'grant_gated_write'
  | 'destructive_write';

export interface KnowledgeEvidence {
  readonly kind: 'tool-registry' | 'input-schema' | 'handler' | 'focused-test' | 'protocol-test';
  readonly tool: string;
  readonly action?: string;
  readonly ref: string;
}

export interface OperationReference {
  readonly tool: string;
  readonly action: string;
}

export interface FeatureDependency {
  readonly from: string;
  readonly to: string;
  readonly kind: DependencyKind;
  readonly authority: DependencyAuthority;
  readonly description: string;
  readonly evidence: readonly [KnowledgeEvidence, ...KnowledgeEvidence[]];
}

export interface FeatureKnowledge {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly dependencies: readonly FeatureDependency[];
  readonly tools: readonly string[];
}

export interface OperationKnowledge {
  readonly id: string;
  readonly tool: string;
  readonly action: string;
  readonly featureId: string;
  readonly capability: ArchCapability;
  readonly scope: OperationScope;
  readonly safety: OperationSafety;
  readonly support: KnowledgeSupport;
  readonly confidenceBasis: 'protocol-verified' | 'implementation-backed';
  readonly requires: readonly string[];
  readonly validatesWith: OperationReference;
  readonly verificationRequiredContext: readonly string[];
  readonly verificationExpectedEvidence: string;
  readonly limitations: readonly string[];
  readonly evidence: readonly KnowledgeEvidence[];
}

export interface ToolKnowledge {
  readonly name: string;
  readonly description: string;
  readonly featureId: string;
  readonly capability: ArchCapability;
  readonly operations: readonly OperationKnowledge[];
}

export interface ArchKnowledgeCatalog {
  readonly schemaVersion: typeof ARCH_KNOWLEDGE_SCHEMA_VERSION;
  readonly generatedFrom: 'runtime-tool-registry';
  readonly features: readonly FeatureKnowledge[];
  readonly tools: readonly ToolKnowledge[];
  readonly operations: readonly OperationKnowledge[];
  readonly dependencies: readonly FeatureDependency[];
}
