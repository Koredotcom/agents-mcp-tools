---
name: arch-platform
description: Plan, execute, and verify Kore.ai Agent Platform work through the Arch MCP server using code-backed operation and dependency knowledge.
---

# Arch Platform Operations

Use Arch as the Agent Platform control plane. Preserve the user's requested scope and obtain authorization before material external mutations.

## Source of Truth

1. Read `arch://guidance/v1/manifest` and the relevant feature or tool detail.
2. Require `schemaVersion` to equal `"1"` before using catalog dependencies, confidence, or planning prompts. If the manifest is absent or incompatible, stop catalog-driven planning and use only legacy tool discovery and existing project-builder operations; do not infer dependencies.
3. Treat schema-derived operations as executable only when support is `implemented` or `verified`.
4. Treat `authoritative-live` readiness as project-specific; inspect it through existing project-builder resources before planning project mutations.
5. Documentation-only or unsupported entries do not authorize an operation.

## Operating Rules

- Resolve every `requires` dependency before mutation.
- Use opaque auth-profile, integration, and MCP-server references; never place raw secrets in ordinary tool arguments.
- Respect `read`, `write`, `idempotent_write`, `grant_gated_write`, and `destructive_write` safety. Treat plain `write` as non-idempotent unless the live operation proves otherwise.
- Before grant-gated or destructive work, show the exact target and obtain the required confirmation/grant.
- If a mutation has an unknown outcome, verify it; never retry blindly.
- After acting, supply the operation's `verificationRequiredContext`, call its `validatesWith` tool/action, and compare the result with `verificationExpectedEvidence`. If the guidance says the validation read cannot prove the original outcome, report that limitation and rely only on the non-replayed original result.
- Do not claim support for platform features absent from the public Arch operation catalog.

Use the `plan-platform-operation` prompt for a new multi-feature task and `verify-platform-operation` after a specific action.
