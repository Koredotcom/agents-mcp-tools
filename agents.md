# packages/mcp-debug — Agent Learnings

## Package Info

- **Package name**: `@koreai/arch-mcp-tools` (NOT `@abl/mcp-debug`)
- **Build**: `tsc` (standard TypeScript compilation)
- **Test**: `vitest` — tests in `src/__tests__/`

## Gotchas

- The npm package name is `@koreai/arch-mcp-tools`, not what the directory name suggests. Use this for `pnpm build --filter=`.
- `fetchWithTimeout` default is 5s — fine for health checks, but too aggressive for auth endpoints on remote servers. Always pass explicit timeouts for auth/token calls (15s recommended).
- `deriveStudioUrl()` in platform-projects.ts rewrites runtime URLs to Studio URLs for project CRUD. If the URL can't be parsed, it should return the original URL unchanged, not fall back to localhost.
- Studio API helpers must keep remote server URLs on the connected origin (for example `https://agents-dev.kore.ai`) and only rewrite explicit local runtime ports to `5173`.
- The `platform-projects.ts` file may be concurrently modified (schema additions). Re-read before editing.
- Credential secret creation must use exclusive file creation (`openSync` with `wx`) and fall back to the existing file on `EEXIST`; otherwise first-run concurrent device auth can encrypt credentials with a secret that gets overwritten by another process.

## Patterns

- Auth cascade: explicit token -> stored credentials -> device auth (RFC 8628)
- `fetchWithTimeout(url, options, timeoutMs)` — third param is timeout in ms, defaults to 5000
- Prefer injected HTTP operations in tool tests instead of `vi.mock('../utils/fetch.js')`; `platformTools`, `debug_docs`, `platformValidatePackage`, `platformImportExport`, package repair tools, eval tools, and `auth-client` have mock-free injected seams that record URL/options/timeout while the production defaults still call the real fetch and credential utilities.
- `platform_workspaces` tests should inject credential read/write dependencies through the tool handler instead of mocking `src/client/credentials.ts`; keep global `fetch` as the external HTTP boundary.
- Credential-store tests should use temp `XDG_CONFIG_HOME`/`HOME` directories and real files instead of mocking `node:fs`; the credential path helpers resolve environment variables at call time.
- WebSocket client tests can use an in-process `WebSocketServer` on `127.0.0.1:0` to validate subprotocols, sends, and dispatch without mocking the `ws` package.

## 2026-07-20 — Generic MCP Discovery Mirrors A Domain Registry

**Category**: project-builder | MCP | resources | prompts | compatibility
**Learning**: Public project building has exactly two generic top-level tools. Static describe,
provider resources, and prompts derive from the immutable provider registry; live project resources
and tool actions renegotiate Studio contract 1.1 on every request and then use the provider's
allow-listed route adapter. Workflow is the first production provider, not a branch in the shared
server. JSON text and structured envelopes must remain semantically identical.
**Files**: `src/tools/platform-project-builder.ts`, `src/project-building/studio-transport.ts`,
`src/project-building/discovery.ts`, `src/server.ts`
**Impact**: Add future capabilities by registering a provider and authoritative Studio reporter.
Do not add feature-specific top-level orchestration tools, cache capability negotiation across
origins/tokens, probe project routes after an ambiguous capability response, or alter legacy string
tool results.

## 2026-05-17 — Distributed MCP Must Stay Thin

**Category**: architecture
**Learning**: The MCP package is distributed outside the platform and must not depend on private workspace compiler/import packages for ABL package diagnostics. Put compiler-backed validation, design linting, transcript diagnosis, and compiler-model introspection behind Studio API endpoints, then keep MCP tools as path/file-map readers plus HTTP wrappers.
**Files**: `src/tools/platform-validate-package.ts`, `src/tools/platform-package-model.ts`, `src/tools/debug-lint-abl.ts`, `src/tools/debug-why-transcript-failed.ts`, `src/utils/package-files.ts`, `src/utils/studio-api.ts`
**Impact**: Future MCP diagnostics should prefer server-owned endpoints and include clear 404 hints for old platform versions. The MCP layer should help operators loop over traces, eval output, and ABL patches without reimplementing compiler/design-analysis logic client-side. Do not import `@abl/compiler`, `@abl/core`, or `@agent-platform/project-io` into this package just to mirror platform behavior.

## 2026-06-02 — Local Runtime Health Uses `/health/live`

**Category**: health-probes | compatibility
**Learning**: `runtimeHealthCheck()` is a localhost reachability check for operator feedback, not a dependency readiness check. It should call Runtime `/health/live` and expect the minimal liveness payload (`{ status: "live" }`) instead of depending on `/health` diagnostics.
**Files**: `src/client/http-client.ts`, `src/tools/connect.ts`, `src/__tests__/http-client.test.ts`, `src/__tests__/connect.test.ts`, `src/__tests__/fetch.test.ts`
**Impact**: Future MCP connection tooling should keep remote URLs on the auth/WebSocket path and use `/health/live` only for local fast-fail checks; do not parse build or dependency details from public probes.

## 2026-06-24 — Standalone Trace Union Needs Analytics Additions

**Category**: trace-registry | compatibility
**Learning**: The distributed MCP debug package intentionally inlines trace event unions for standalone publishability. When shared-kernel adds a runtime-emitted trace domain such as analytics, add the literal to `src/types.ts` so trace filters and event buffers accept the new event without requiring private workspace imports.
**Files**: `src/types.ts`
**Impact**: Future shared-kernel trace-domain additions need a quick MCP debug propagation pass unless the package has moved to a generated/public trace contract.

## 2026-06-25 — URL Scheme Rewrites Must Be Scheme-Anchored

**Category**: security | url | compatibility
**Learning**: `deriveUrls()` should rewrite only URL schemes (`http:`/`https:`/`ws:`/`wss:`), not arbitrary leading text. This preserves support for local and remote Runtime URLs while avoiding broad string replacements that static analysis correctly treats as risky.
**Files**: `src/utils/url.ts`
**Impact**: Future URL helpers in the distributed MCP package should use `URL` parsing or scheme-anchored replacements and keep invalid/unparseable inputs flowing through existing compatibility behavior.

## 2026-06-27 — Eval Preflight Sanitizer Must Track Studio

**Category**: evals | compatibility | preflight
**Learning**: The MCP eval tools may receive raw preflight diagnostics from
older Studio deployments, so its standalone sanitizer must keep parity with
Studio's public check vocabulary. Map internal `judge_token_split_schema` to
`usage_telemetry` and `voice_runner` to `voice_eval_execution` before returning
operator-facing JSON.
**Files**: `src/utils/eval-preflight-sanitizer.ts`,
`src/__tests__/platform-evals.test.ts`
**Impact**: Future eval preflight checks need duplicate sanitizer updates in
Studio and MCP until both consume a shared public contract. Treat raw table,
column, provider, tenant, and env-var text as non-public.

## 2026-06-27 — Model Availability Preflight Sanitizer Parity

**Category**: evals | compatibility | preflight
**Learning**: `provider_model_availability` is an internal Pipeline Engine
check for cases where model resolution succeeds but the live provider would
reject the selected model. MCP maps it to Studio's public
`model_configuration` category and strips retired model IDs/provider names from
older/raw Studio preflight responses.
**Files**: `src/utils/eval-preflight-sanitizer.ts`,
`src/__tests__/platform-evals.test.ts`
**Impact**: Keep MCP public readiness output in lockstep with Studio. Any
Pipeline Engine preflight check that includes operational IDs, provider names,
schema names, env vars, or tenant/project details needs explicit sanitizer
coverage here.

## 2026-06-30 — Credential Tests Must Own HOME Before Imports

**Category**: testing | credentials | isolation
**Learning**: Credential path helpers can capture macOS `HOME`-derived config
locations during module import. Credential-store tests that exercise real files
should create a temp HOME/XDG root before dynamically importing credential
helpers, then clean that same root between tests.
**Files**: `src/__tests__/credentials.test.ts`
**Impact**: Future MCP credential tests should avoid importing credential
modules at file top level when asserting filesystem isolation. Use real temp
files rather than platform mocks, but make the temp HOME lifetime file-scoped
so `env-paths` and related helpers cannot read a developer's stored
credentials.

## 2026-07-02 — Studio API Calls Need Same-Origin Headers

**Category**: studio-api | csrf | mcp | compatibility
**Learning**: Server-side MCP tools that POST to Studio APIs should send an
`Origin` header matching the derived Studio origin. Local Runtime URLs still
rewrite to the local Studio port via `deriveStudioUrl()`, while remote
deployments keep their connected origin. This satisfies Studio's browser CSRF
guard without weakening proxy policy or adding per-tool exceptions.
**Files**: `src/utils/studio-api.ts`,
`src/__tests__/studio-api.test.ts`,
`src/__tests__/package-repair-tools.test.ts`,
`src/__tests__/platform-validate-package.test.ts`,
`src/__tests__/platform-tools.test.ts`
**Impact**: Future tools that use Studio mutation or package-analysis APIs
should call `buildStudioHeaders(ctx, studioBase)` instead of hand-building
headers. Rebuild the package after source edits; long-lived MCP server
processes may still need restart before live probes pick up the new `dist`.

## 2026-07-20 — Lifecycle MCP Tools Mirror the Public CLI Contract

**Category**: lifecycle | distribution | compatibility
**Learning**: The canonical published package is `@koreai/arch-mcp-tools`; the older `@koredotcom/agents-mcp-tools` name in this file's historical package-info section is stale. This distributed package must remain standalone, so its existing `platform_versions` and `platform_deployments` adapters mirror the CLI's public Runtime contract without importing private workspace CLI code. Publish derives the same raw-DSL SHA-256 guard; deployment writes use the same typed manifest shape and confirmation policy.
**Files**: `src/tools/platform-versions.ts`, `src/tools/platform-deployments.ts`, `src/tools/index.ts`
**Impact**: Keep adapters thin and route-owned: retain returned version/deployment identifiers, never invent automatic rollback, and add parity tests whenever Runtime version or deployment Zod contracts change.

## 2026-07-20 — Public Builder Contracts Need Process-Level Compatibility Proof

**Category**: testing | mcp | studio | compatibility | isolation
**Learning**: A distributed MCP project-builder contract needs three distinct
proof layers: package contract/coverage tests, a spawned built MCP process that
crosses real Studio HTTP auth/project middleware, and a release lane against a
real immutable prior Studio version. For v1.1 the prior baseline is tag
`Artemis_1.1.0` at commit
`0f4d97e3fe66cff58614be7ef38158db4d635c23`; its missing builder route must
normalize to `STUDIO_CAPABILITY_UNKNOWN` without raw-body or primitive-tool
fallback. Only an explicit lower-version capability response is
`STUDIO_UPGRADE_REQUIRED`. Keep current and prior Studio persistence isolated, poll readiness,
fail fast, and clean only runner-owned PIDs/worktrees.
Use the explicit `--studio-url` process option when compatibility Studio runs on a port other than
the local 5173 default; this override applies to the project-builder Studio transport without
changing legacy primitive routing.
**Files**: `src/__tests__/project-builder.mcp.e2e.test.ts`,
`scripts/run-project-builder-e2e.mjs`,
`scripts/run-old-studio-compat.mjs`, `scripts/run-actor-upgrade-compat.mjs`
**Impact**: Future public MCP additions should pin an immutable server baseline,
retain JSON-text compatibility beside structured content, and prove actor
isolation at the authoritative Studio query boundary rather than only inside
the MCP adapter.

## 2026-07-24 — Project Inspection Is Not Operation Inspection

**Category**: project-builder | compatibility | release-evidence
**Learning**: `platform_project_builder(action="inspect", domain="project")` must inventory
authoritative project resources before any durable operation exists. Domain reporters need a
read-only project inventory path; they must not require, select, or persist a workflow-builder
operation just to inspect the project. Operation-specific dependency/readiness reports still use
the visible operation. Real-process tests also need explicit live-call budgets because Studio
cold-compiles routes and routinely exceeds Vitest's five-second unit default.
**Files**: `apps/studio/src/lib/arch-ai/workflow-builder/dependency-service.ts`,
`apps/studio/src/lib/arch-ai/project-builder/workflow-domain-reporter.ts`,
`src/__tests__/project-builder.mcp.e2e.test.ts`
**Impact**: Future providers should implement project inventory separately from durable operation
state, return `not_evaluated` rather than fabricated readiness when no operation exists, and keep
bounded release-lane timeouts explicit.

## 2026-07-24 — Immutable Lanes Need Ordered Bootstrap

**Category**: testing | compatibility | release-evidence
**Learning**: A frozen install is not enough to run an immutable monorepo worktree when workspace
packages publish `dist` entry points. Compatibility runners need an ordered, argv-only bootstrap
list so they can install the pinned lockfile, build Runtime's transitive workspace dependencies,
and prepare Studio's required distributions before starting services. Keep the singular bootstrap
command as a compatibility alias. Use a non-watch old Runtime command so startup validation
failures terminate and the runner can fail fast.
**Files**: `scripts/project-builder-runner-lib.mjs`, `scripts/run-old-studio-compat.mjs`,
`scripts/run-actor-upgrade-compat.mjs`, `scripts/README.md`
**Impact**: Future immutable provider lanes can add deterministic preparation steps without shell
composition, while preserving pinned-commit verification, bounded readiness, and runner-owned
cleanup.

## 2026-08-19 — Historical Tools Need a Verified Prior-Version Contract Intersection

**Category**: compatibility | MCP | runtime
**Learning**: A public MCP filter must not be sent to an older supported Runtime that silently
ignores it. Define the public v1 query surface as the source-verified current/prior intersection,
reject current-only fields with a strict MCP schema before HTTP, and assert filter semantics in the
immutable lane. When the generic Zod discovery converter cannot express bounds, defaults, or strict
objects, use a tool-local precomputed JSON Schema through a narrow optional registry field so legacy
tool discovery remains byte/deep-compatible.
**Files**: `src/tools/session-history.ts`, `src/tools/index.ts`, `src/server.ts`,
`scripts/session-history-runner-lib.mjs`
**Impact**: Future Runtime-backed MCP tools must prove that every advertised filter has the same
meaning on every supported server version; route existence alone is not compatibility evidence.

## 2026-07-24 — Compatibility and Actor-Upgrade Baselines Differ

**Category**: testing | migrations | compatibility
**Learning**: The immutable prior-Studio capability baseline can predate a feature, but an
actor-upgrade fixture must use the last immutable commit that still exposes the old write API. For
workflow-builder actor enforcement that commit is
`baa4271749e2e06e19d32835cb27c5ec5eee9443`; the Artemis capability baseline has no workflow-build
route. Keep runner-owned Mongo/Redis alive while old Studio stops, registered migrations run, and
current Studio starts. The upgrade database also needs the old release's genuine migration ledger:
a fresh database presents all historical migrations as pending and must not bypass forward-only
approval policy just to reach the feature migration.
**Files**: `scripts/project-builder-runner-lib.mjs`,
`scripts/run-actor-upgrade-compat.mjs`, `scripts/README.md`
**Impact**: Future upgrade lanes must distinguish protocol compatibility from data-upgrade
baselines, preserve transition infrastructure, and start from a release-owned migrated snapshot or
equivalent supported old-version initialization.

## 2026-08-05 — Command Readiness Success Tests Need Process-Startup Headroom

**Category**: testing | compatibility | process-readiness
**Learning**: A command-readiness success test must not assume a fresh Node subprocess can spawn
and exit within 100 ms. Under low-memory serialized pre-push load, a correct `process.exit(0)` probe
can exceed that threshold. Use the runner's bounded five-second probe window for the success path,
while retaining a short non-zero-exit row to prove readiness still times out with the expected
error code.
**Files**: `src/__tests__/project-builder-runner-lib.test.mjs`,
`scripts/project-builder-runner-lib.mjs`
**Impact**: Future process-runner tests should distinguish deterministic timeout behavior from
machine scheduling latency; tiny deadlines belong on injected probes, not real subprocess starts.

## 2026-07-22 — Environment and Workspace Changes Are Atomic Context Transitions

**Category**: auth | credentials | websocket | isolation
**Learning**: Serialize `platform_connect` and `platform_workspaces` transitions on
the shared debug context. Keep the published URL/token and old WebSocket live while
authenticating a candidate socket, then atomically persist scoped credentials, and
only then promote the candidate, publish the HTTP context, and clear session/trace
stores. A handshake or credential failure must only abort the unpublished candidate;
it must not require reconstructing the old connection. Fence WebSocket
callbacks and reconnect timers by connection generation so a superseded socket
cannot repopulate cleared context. Accept switched/refreshed credentials only when
the JWT tenant and subject match the requested tenant and current principal; never
inherit refresh/email metadata across server origins or subjects. MFA/SSO workspace
policy must resume through a purpose-bound device grant on the derived Studio API,
not a browser-cookie redirect returned by the tenant-switch endpoint.
**Files**: `src/client/auth-client.ts`, `src/client/credentials.ts`,
`src/client/websocket-client.ts`, `src/tools/connect.ts`,
`src/tools/platform-workspaces.ts`, `src/tools/workspace-switch-contract.ts`,
`src/utils/context-transition.ts`, `src/utils/platform-context.ts`
**Impact**: Future connection/workspace changes must return identity-aware
`activeTarget` plus `contextVersion`, require explicit `force=true` before changing
an active environment, and use dependency injection plus an in-process
`WebSocketServer` for candidate/generation regressions. Do not use internal module
`vi.mock` calls for these tests.

## 2026-07-22 — Remote Auth and Context Contracts Are Resource-Bounded

**Category**: auth | websocket | resource-safety | concurrency
**Learning**: Read remote auth/workspace bodies through a byte-bounded stream before
JSON parsing, cap workspace cardinality and every identity string, and require a
finite future JWT `exp` before persisting or publishing a switched context. WebSocket
candidate buffers need explicit message and byte bounds; a prepared replacement commit
must throw when promotion is no longer safe so callers can roll credentials back.
Refresh transitions must be single-flight per credential identity and tenant, then
compare-and-swap against the latest persisted context before saving.
**Files**: `src/utils/bounded-response.ts`, `src/tools/workspace-switch-contract.ts`,
`src/tools/platform-workspaces.ts`, `src/client/auth-client.ts`,
`src/client/websocket-client.ts`
**Impact**: Auth and workspace responses must define explicit byte/cardinality bounds
and validate contracts before allocation or mutation. Treat credential, transport,
and workspace updates as one rollback-capable transition.

# Arch MCP Tools — Guide for AI Agents

> Release target: `@koreai/arch-mcp-tools@1.5.0`. This is a substantial `1.x` feature release,
> not a breaking SemVer major. Package `1.5.0` continues to consume knowledge schema `v1`; always
> read `arch://guidance/v1/manifest` and fall back to legacy operations when that schema is absent
> or incompatible. Do not infer publication from repository versioning alone—the production npm
> promotion remains the release authority.

You are an AI agent (Claude Code, Codex, or similar) with access to the
**`arch-agent-platform`** MCP server, provided by the `@koreai/arch-mcp-tools`
package. It lets you **build, evaluate, optimize, debug, and analyze** projects on
the Kore.ai Agent Platform. This guide tells you how to drive the tools well.

> The tool surface is "Arch" — the personified operator for the platform. The MCP
> server key is `arch-agent-platform` and tools are prefixed `platform_*` and `debug_*`.

## Golden rules

1. **Connect first.** Call `platform_connect` before any other tool. Nothing else
   works until the WebSocket is connected and authenticated.
2. **Ask which environment if it isn't set.** If no `serverUrl` is passed and the
   `AGENTS_URL` env var is unset, ask the user which environment to use — do not guess:
   | Environment | URL |
   | ----------- | -------------------------------- |
   | Production | `https://agents.kore.ai` |
   | Dev | `https://agents-dev.kore.ai` |
   | Staging | `https://agents-staging.kore.ai` |
   | QA | `https://agents-qa.kore.ai` |
   | Local Studio | `http://localhost:5173` |
   For local Studio testing, set `AGENTS_URL=http://localhost:5173` in the MCP
   server env or pass `serverUrl: "http://localhost:5173"` to `platform_connect`.
   Treat localhost as a per-session override, not a production default.
3. **Auth is automatic.** `platform_connect` tries, in order: an explicit `authToken` →
   stored credentials (scoped to the server and principal) → device auth (opens a browser and
   polls until approved, in the same call). You rarely need to pass a token.
4. **Errors are terminal — report them as-is.** If a tool fails, surface the error to
   the user. Do **not** invent workarounds, retry with raw REST/HTTP calls, or fabricate
   results. The MCP server is the only supported path.
5. **Keep context visible.** Surface `activeTarget` after connect, token refresh, or
   workspace switch so the user can verify environment, workspace, and principal.
   Never change an active environment without explicit `force=true`.

## Tool families

**Build** — create and change projects, agents, tools, config, versions, deployments:
`platform_projects`, `platform_agents`, `platform_tools`, `platform_workflows`,
`platform_auth_profiles`, `platform_integrations`, `platform_mcp_servers`, `platform_config`,
`platform_versions`, `platform_deployments`, `platform_import_export`,
`platform_workspaces`, `platform_sdk_channels`, `agent_tables`.

**Evaluate** — generate eval assets and run eval workflows:
`platform_eval_personas`, `platform_eval_scenarios`, `platform_eval_evaluators`,
`platform_eval_sets`, `platform_eval_runs`, `debug_harness_logs`.

**Optimize** — validate packages and inspect what the compiler sees:
`platform_validate_package`, `platform_package_model`, `debug_lint_abl`,
`debug_why_transcript_failed`, `debug_diagnose_transcript`.

**Debug** — connect to live sessions, trace failures, inspect execution state:
`platform_connect`, `debug_list_agents`, `debug_load_agent`, `debug_send_message`,
`debug_get_current_state`, `debug_traces`, `debug_get_span_tree`,
`debug_explain_decision`, `debug_get_flow_graph`, `debug_get_errors`,
`debug_list_active_sessions`, `debug_session`.

**Analyze** — explain docs, diagnostics, and health signals:
`debug_docs`, `debug_diagnose`, `debug_analyze_session`.

See `README.md` for the full per-tool description table.

## Playbooks (recommended tool sequences)

**Debug a failing conversation**

1. `platform_connect`
2. `debug_list_active_sessions` (find the session) or `debug_load_agent` (start a fresh one)
3. `debug_send_message` to reproduce
4. `debug_traces` / `debug_get_span_tree` to see what happened
5. `debug_get_errors` and `debug_explain_decision` to localize the cause
6. `debug_diagnose` or `debug_why_transcript_failed` for a correlated root-cause + fix

**Build or modify an agent**

1. `platform_connect`
2. `platform_projects` (pick/create the project)
3. `platform_agents` (`get` the DSL, then `save_dsl` your change) and `platform_tools` as needed
4. `platform_validate_package` / `platform_package_model` to confirm it compiles cleanly
5. `platform_versions` (`publish` with the current draft hash guard) → `platform_deployments` (typed create/promote/rollback/restore/retire)

**Build a workflow-backed agent project**

1. `platform_connect` → `platform_projects`
2. `platform_auth_profiles` (metadata/OAuth) → `platform_integrations` or `platform_mcp_servers`
3. `platform_mcp_servers(discover_preview → discover_import)` when MCP tools are required
4. `platform_workflows(create → publish → create_tool)`
5. `platform_agents(get → save_dsl)` to add the returned ProjectTool signature, then `platform_versions(create)` to compile it
6. `platform_tools(test)` and `platform_workflows(execute)` before deployment

Never put raw secrets in MCP tool arguments. `platform_auth_profiles(create)` may create only
`authType: "none"`; credential-bearing creation must return a secure Studio handoff. Complete secret
entry and OAuth consent through the secure Studio flow, then use opaque profile IDs in MCP calls.

**Public project-builder contract invariants**

- Keep this published package standalone. Public MCP ontology and presentation contracts live here; private Arch/harness schemas are build-time parity sources, not runtime dependencies.
- Live dependency graphs, readiness, operation state, grants, resume, and repair remain authoritative in Studio workflow-builder services. Do not reconstruct them by fanning out across primitive MCP tools.
- Add structured content and output schemas alongside JSON-in-text responses until legacy-client compatibility evidence supports a migration.
- Enforce creator-operation hiding at the authoritative Studio service/query boundary; the MCP adapter must not be the only cross-user isolation layer.

**Run an evaluation**

1. `platform_connect`
2. `platform_eval_personas` / `platform_eval_scenarios` / `platform_eval_evaluators` (assets)
3. `platform_eval_sets` (group them)
4. `platform_eval_runs` (`start`, then poll `status`, read `heatmap` / cases)

**Repair a project to a behavior target (SOP → ABL convergence)**

Offline-first loop — steer by _layer movement_, not the average score:

1. Normalize the SOP into per-scenario contracts (expected path, required context, tool order, fixtures, expected outcome, must-nots).
2. `platform_validate_package` / `platform_package_model` / `debug_lint_abl` — prove static safety **and** producer→consumer graph completeness on every reachable path.
3. `debug_load_agent` → `debug_send_message` → `debug_traces` / `debug_get_span_tree` — focused runtime transcripts for the target layer.
4. `debug_diagnose` / `debug_why_transcript_failed` — root-cause; classify the owner (SOP / tool / generation / model / prompt / validation / eval / judge / runtime).
5. Patch the **smallest** ABL surface that moves one layer via `platform_agents(save_dsl)` — surgical/lossless, source-backed, generic for the family.
6. Re-validate, re-run focused transcripts, then `platform_eval_runs` full matrix only when structurally safe. **Lock** the improved layer before expanding.

Golden repair rules: native `INTENTS`+`intent.category`+`HANDOFF` (never `GATHER routing_category`); bind every tool input to a proven producer; gate write tools behind policy + confirmation; render responses from typed outcome fields; accept a patch only if a target layer improves with no safety/runtime regression. **Full methodology: [`REPAIR-PLAYBOOK.md`](REPAIR-PLAYBOOK.md).**

## Reading results

- **Traces** (`debug_traces`) are the source of truth for what executed — filter by
  type, agent, text, error, or session.
- **Span tree** (`debug_get_span_tree`) shows the execution hierarchy; use it to see
  where time or control flow went.
- **Flow graph** (`debug_get_flow_graph`) renders the state machine (JSON or Mermaid) —
  useful for explaining routing, handoffs, and gather steps.
- **Decisions** (`debug_explain_decision`) explain _why_ the agent chose a branch.

## Install (for the user)

Add to `.mcp.json` or `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "arch-agent-platform": {
      "command": "npx",
      "args": ["-y", "@koreai/arch-mcp-tools"]
    }
  }
}
```

To pin an environment, add an `env` block with `AGENTS_URL` set to one of the URLs above.

## 2026-08-06 — MCP Publish Mirrors Companion-Aware Runtime Hashing

**Category**: lifecycle | versioning | compatibility | parity
**Learning**: When `platform_versions publish` derives its guard, it must prefer the non-empty `sourceHash` returned by Runtime and fall back to raw-DSL SHA-256 only for older agent responses. Explicit caller-supplied hashes continue to bypass the agent GET.
**Files**: `src/tools/platform-versions.ts`, `src/__tests__/platform-versions.test.ts`
**Impact**: Add parity rows whenever Runtime changes the agent-detail or publish concurrency contract; the distributed MCP adapter must stay standalone but behaviorally aligned with the CLI.

## 2026-08-19 — Durable History Must Stay Separate From Live Debug State

**Category**: tracing | compatibility | isolation | resource safety
**Learning**: Runtime already owns authorized durable session listing and merged memory/ClickHouse trace pages. Arch MCP historical access should be an additive, explicit read-only tool. Do not infer history from an empty local buffer, alter existing debug-tool contracts, or hydrate durable events into the bounded live `TraceStore`. Preserve Runtime page ordering across offset pagination, distinguish project-wide platform/API-key access from owner-scoped SDK-session access, and bound remote response count, bytes, and time.
**Files**: `src/tools/traces.ts`, `src/tools/subscription.ts`, `src/client/http-client.ts`, `src/client/event-buffer.ts`, `src/tools/session-history.ts`
**Impact**: Historical MCP adapters must remain standalone, project-scoped, failure-transparent, and compatible with old clients and mixed Runtime versions.

## 2026-08-19 — History Test Lanes Separate MCP Auth From Runtime SDK Auth

**Category**: testing | authentication | compatibility
**Learning**: The Arch MCP context currently carries bearer JWT/API-key credentials only. Do not claim an MCP SDK-session lane without adding explicit credential lifecycle and `X-SDK-Token` plumbing. Keep SDK ownership as a Runtime route regression; prove MCP client neutrality with standards SDK clients over in-memory and built stdio transports. For durable history, new integration/E2E authority requires real Mongo, Redis, and ClickHouse rather than relying only on HTTP storage shims.
**Files**: `src/client/http-client.ts`, `src/__tests__/project-builder-mcp-discovery.test.ts`, `src/__tests__/project-builder.mcp.e2e.test.ts`
**Impact**: Test specs must map credential type to an actually supported transport and distinguish route regression evidence from end-to-end MCP evidence.

## 2026-08-19 — Public History Reads Need Transport and Envelope Bounds

**Category**: resource safety | MCP contracts | errors
**Learning**: For historical reads, use one additive `getBoundedJson` path with a single deadline across headers and body, an incremental byte cap, and typed malformed-JSON errors that retain the received HTTP status. Normalize only the history envelope, preserve Runtime page order, and keep the generic GET/parser behavior unchanged for existing callers.
**Files**: `src/client/http-client.ts`, `src/utils/bounded-response.ts`, `src/tools/session-history.ts`, `src/server.ts`
**Impact**: Future remote MCP reads must prove declared and chunked over-limit behavior, late-body timeout, sanitized diagnostics, exact discovery bounds, and legacy caller compatibility.

## 2026-08-20 — Public Operation Knowledge Must Be Derived and Fail Soft

**Category**: knowledge | MCP contracts | compatibility | packaging
**Learning**: Derive public Arch operations from the same effective input schema used by `tools/list`; keep semantic ownership exhaustive and validate every operation, dependency, safety mode, evidence record, and verification reference against code. Provider-owned project-builder action modes remain authoritative. Construct and cache the catalog lazily for guidance reads so drift cannot disable legacy MCP behavior. Client guidance must be an explicit, hash-owned installation from the packed canonical skill—normal MCP startup never writes client files.
**Files**: `src/tools/index.ts`, `src/knowledge/`, `src/guidance-installer.ts`, `src/server.ts`, `skills/arch-platform/`
**Impact**: Future tool/action changes must update the validated knowledge census, the 45-tool compatibility digest, provider safety parity, bounded guidance projections, and clean-package installer tests in the same change.

## 2026-08-20 — Confidence And Verification Are Operation-Scoped Contracts

**Category**: knowledge | confidence | verification | testing
**Learning**: File existence or a tool-wide smoke test is not evidence that every action works. Keep an explicit `tool:action` confidence inventory independent from safety/schema metadata, and bind each actionable entry to a passing behavior contract that checks its handler outcome and exact transport effects (or to a stronger focused/protocol suite). Only operations with explicit protocol evidence may claim protocol-verified support. Verification guidance must also be keyed by `tool:action`: select a follow-up that can observe that action's result, name the identifiers/context it needs, and state the evidence required to claim success. A descriptive read cannot prove a row mutation, tool execution, live-external validation, or multi-asset import.
**Files**: `src/knowledge/confidence-evidence.ts`, `src/knowledge/verification-guidance.ts`, `src/__tests__/operation-confidence.contract.test.ts`, `src/__tests__/knowledge-catalog.test.ts`
**Impact**: Adding or changing an action requires its behavior evidence, safety/approval classification, and operation-specific verification contract in the same change; publication fails on any census drift.

## 2026-08-20 — RC Publication Must Preserve Full Version And Nested Npm Semantics

**Category**: release | packaging | compatibility | testing
**Learning**: The dev release rewrite must apply the complete prerelease version to both
`package.json` and MCP server metadata so initialization and installer ownership manifests describe
the artifact actually installed. An outer `npm publish --dry-run` exports
`npm_config_dry_run=true` into lifecycle tests; clean-package E2E must explicitly set it to `false`
for nested `npm pack` and `npm install` commands or npm reports a filename without creating the
tarball.
**Files**: `tools/release-mcp-tools.sh`, `src/tools/persona.ts`,
`src/__tests__/persona.test.ts`, `src/__tests__/guidance-package.e2e.test.ts`,
`src/__tests__/release-script.test.ts`
**Impact**: Every release candidate dry run must pass the same package/server version-parity and
clean-installed process tests as production before npm publication is allowed. Cleanup must fail
visibly and retain its recovery directory if any temporarily rewritten source file cannot be
restored.
