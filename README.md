# Arch MCP Tools

`@koreai/arch-mcp-tools` is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that connects your AI coding assistant to the **Kore.ai Agent Platform**. It gives the assistant a set of tools to **build, evaluate, optimize, debug, and analyze** agents on the platform — create and edit projects, agents, and tools; run evaluations; inspect live sessions and traces; and diagnose failures — directly from your editor or terminal.

It works with any MCP-compatible client (Claude Code, Cursor, VS Code, Codex CLI, and others). The server is exposed to clients under the name **`arch-agent-platform`**, and its tools are prefixed `platform_*` and `debug_*`.

## `1.5.0` release

`@koreai/arch-mcp-tools@1.5.0` is a substantial feature release while remaining a SemVer minor
update within the `1.x` compatibility line.

The release adds:

- code-derived coverage for all 45 public tools and 179 schema-declared operations across 13 feature
  groups;
- operation-scoped confidence, safety, prerequisites, limitations, dependencies, and verification
  guidance;
- additive `arch://guidance/v1/*` resources plus planning and verification prompts;
- one schema-gated Codex/Claude skill installed only through the ownership-safe
  `arch-mcp-guidance` command; and
- clean-package, authorization/isolation, compatibility, failure-isolation, and four-metric coverage
  gates.

The knowledge protocol remains schema version `1`; the package version and knowledge schema version
are intentionally independent. Existing 45-tool discovery, tool names and schemas, initialization
instructions, project-builder payloads/order, and prior-Studio downgrade behavior remain unchanged.
New resources and prompts are appended, and guidance construction fails soft without disabling the
legacy MCP surface.

Consumers can pin the release explicitly:

```bash
npx -y @koreai/arch-mcp-tools@1.5.0
```

## Requirements

- **Node.js 18 or newer** — the server runs via `npx`, no separate install needed.
- A **Kore.ai Agent Platform account** — you authenticate on first connect (see [Authentication](#authentication)).

## Install

`@koreai/arch-mcp-tools` is a standard **stdio MCP server**. Every client launches it the same way:

```
command:  npx
args:     -y  @koreai/arch-mcp-tools
```

Add it under a server named `arch-agent-platform` using your client's config below. The unpinned
form follows the npm `latest` tag; use `@koreai/arch-mcp-tools@1.5.0` for a reproducible install.
(No environment is baked in — see [Choosing an environment](#choosing-an-environment).)

### Claude Code

```bash
claude mcp add arch-agent-platform -- npx -y @koreai/arch-mcp-tools
```

Or add it to `.mcp.json` (project) or `~/.claude.json` (global):

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

### Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

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

### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json` — note the top-level key is `servers` (not `mcpServers`):

```json
{
  "servers": {
    "arch-agent-platform": {
      "command": "npx",
      "args": ["-y", "@koreai/arch-mcp-tools"]
    }
  }
}
```

### Codex CLI

```bash
codex mcp add arch-agent-platform -- npx -y @koreai/arch-mcp-tools
```

Or add to `~/.codex/config.toml` — note this is **TOML**, not JSON:

```toml
[mcp_servers.arch-agent-platform]
command = "npx"
args = ["-y", "@koreai/arch-mcp-tools"]
```

### Any other MCP client

Configure a **stdio** server with command `npx` and args `["-y", "@koreai/arch-mcp-tools"]`. Optionally set an `AGENTS_URL` environment variable to pin an environment.

### Optional Codex or Claude guidance skill

The package ships one canonical `arch-platform` skill grounded in the server's versioned operation
catalog. Installation is explicit and never runs as part of normal MCP startup:

```bash
# User scope
npx -y -p @koreai/arch-mcp-tools arch-mcp-guidance install --client codex --scope user
npx -y -p @koreai/arch-mcp-tools arch-mcp-guidance install --client claude --scope user

# Project scope (run in the project root)
npx -y -p @koreai/arch-mcp-tools arch-mcp-guidance install --client codex --scope project
npx -y -p @koreai/arch-mcp-tools arch-mcp-guidance install --client claude --scope project
```

The installer refuses unmanaged or modified files and records hashes in an ownership manifest.
Replace `install` with `uninstall` to remove only unchanged files owned by this package.

### Or just ask your assistant

Paste this into your coding tool's chat and it will wire the server up for you:

> Add an MCP server named `arch-agent-platform` that runs `npx -y @koreai/arch-mcp-tools`, and put it in this project's MCP config.
> Config location by tool — Claude Code: `.mcp.json` (`mcpServers`) · Cursor: `.cursor/mcp.json` (`mcpServers`) · VS Code: `.vscode/mcp.json` (`servers`) · Codex: `~/.codex/config.toml` (`[mcp_servers.arch-agent-platform]`).
> Optionally set `AGENTS_URL` to my environment.

## Choosing an environment

No environment is hardcoded. On first use, the tools ask which environment to connect to — or you can pin one by setting `AGENTS_URL` in the server's `env` (or by passing `serverUrl` to `platform_connect`).

| Environment | URL                              |
| ----------- | -------------------------------- |
| Production  | `https://agents.kore.ai`         |
| Dev         | `https://agents-dev.kore.ai`     |
| Staging     | `https://agents-staging.kore.ai` |
| QA          | `https://agents-qa.kore.ai`      |

Example with a pinned environment (Claude Code / Cursor shape):

```json
{
  "mcpServers": {
    "arch-agent-platform": {
      "command": "npx",
      "args": ["-y", "@koreai/arch-mcp-tools"],
      "env": {
        "AGENTS_URL": "https://agents.kore.ai"
      }
    }
  }
}
```

## Code-backed operation and dependency knowledge

Arch exposes additive `arch://guidance/v1/*` resources for the catalog manifest, feature families,
all schema-derived operations, dependency edges, and per-feature/per-tool detail. Every published
tool appears exactly once; actions come from the same effective input schema advertised to MCP
clients. Curated safety, scope, prerequisites, support, limitations, and verification references
are accepted only when they resolve to real tools/actions.

Use `plan-platform-operation` before multi-feature work and `verify-platform-operation` after a
specific action. Static dependencies guide ordering; authenticated project-builder reports remain
the authority for live project readiness. Features without public Arch MCP operations are not
presented as executable support.

## Tools

### Arch Build

Create and change platform projects, workflows, agents, tools, auth profiles, integrations, MCP servers, configuration, versions, deployments, and imports.

| Tool                                  | Description                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `platform_projects`                   | Manage projects (list, get, create, update, delete)                              |
| `platform_workflows`                  | Create, update, publish, execute, and expose workflows as tools                  |
| `platform_auth_profiles`              | Manage profile metadata and start secure OAuth flows                             |
| `platform_integrations`               | Create, update, test, and remove connector connections                           |
| `platform_mcp_servers`                | Provision MCP servers; discover, import, and test tools                          |
| `platform_agents`                     | Manage agents (list, get, save_dsl)                                              |
| `platform_versions`                   | Manage immutable versions (list, get, publish, qualifications, audit, diff)      |
| `platform_deployments`                | Manage typed deployments (list, get, create, promote, rollback, restore, retire) |
| `platform_sdk_channels`               | Create SDK keys and web/mobile/API channels                                      |
| `platform_tools`                      | Manage tools (list, get, create, update, delete, test)                           |
| `platform_import_export`              | Import and export projects                                                       |
| `platform_config`                     | Manage project and LLM configuration                                             |
| `platform_workspaces`                 | List, switch, and inspect active workspaces                                      |
| `platform_arch_sop`                   | Drive Studio Arch SOP-build sessions                                             |
| `platform_arch_auto_loop`             | Drive project-scoped Arch Auto Loop repair workflows                             |
| `platform_project_builder`            | Discover provider contracts, inspect live dependencies/readiness, and plan       |
| `platform_project_builder_operations` | Continue durable operations and execute attempt-bound governed actions           |
| `agent_tables`                        | Manage Agent Tables definitions and project-scoped rows                          |

#### Scalable project-builder protocol

The project-builder surface is intentionally feature-neutral. Clients learn the core ontology and
registered providers through `platform_project_builder(action: "describe")`, MCP resources, and
prompts. They do not reconstruct cross-feature dependencies by calling primitive tools and joining
responses locally.

Workflow is the first v1.1 provider. A future feature adds one provider registration with its own
qualified kinds, actions, schemas, imports/exports, readiness owner, and allow-listed Studio route
adapter; it does not add another top-level orchestration convention. Live requests negotiate Studio
contract support every time and then make one authoritative project/provider request. An absent or
ambiguous capability response is reported as `STUDIO_CAPABILITY_UNKNOWN`; only an explicitly lower
advertised contract is `STUDIO_UPGRADE_REQUIRED`.

Use `platform_project_builder_operations` for durable
list/read/report/resume/cancel/grant/execute flows.
Side effects require the exact operation version and attempt-bound grant returned by Studio. Never
retry a consumed attempt with an unknown outcome, and never send raw secrets—create or authorize an
auth profile through the secure Studio flow and pass only opaque references.

`platform_auth_profiles(create)` creates only `authType: "none"` profiles. Credential-bearing
profiles intentionally return a `secureSetupRequired` handoff because API keys, client secrets,
certificates, and tokens must never enter MCP/model context. After secure Studio setup, MCP can
list, inspect, update metadata, validate, revoke, initiate OAuth (including non-secret
`connectionConfig` template values), and bind the opaque profile ID to integrations or MCP servers.

### Arch Evaluate

Generate eval assets, run eval workflows, and read CI evidence.

| Tool                       | Description                                      |
| -------------------------- | ------------------------------------------------ |
| `platform_eval_personas`   | Manage and generate eval personas                |
| `platform_eval_scenarios`  | Manage and generate eval scenarios               |
| `platform_eval_evaluators` | Manage eval evaluators and templates             |
| `platform_eval_sets`       | Manage eval sets                                 |
| `platform_eval_runs`       | Manage eval runs, preflight, cases, and heatmaps |
| `debug_harness_logs`       | Get CI execution logs                            |

### Arch Optimize

Validate packages, inspect compiler-visible models, and drive repair loops.

| Tool                          | Description                                                             |
| ----------------------------- | ----------------------------------------------------------------------- |
| `platform_validate_package`   | Validate a local package and optional import preview                    |
| `platform_package_model`      | Show compiler-visible agents, tools, constraints, refs, and diagnostics |
| `debug_lint_abl`              | Run ABL repair and design lint checks                                   |
| `debug_why_transcript_failed` | Correlate transcript symptoms with ABL file/line causes                 |
| `debug_diagnose_transcript`   | Alias for transcript failure diagnosis                                  |

### Arch Debug

Connect to live sessions, trace failures, and inspect execution state.

| Tool                         | Description                                        |
| ---------------------------- | -------------------------------------------------- |
| `platform_connect`           | Connect and authenticate to the platform           |
| `debug_list_agents`          | List available agents by domain                    |
| `debug_load_agent`           | Load an agent and create a debug session           |
| `debug_send_message`         | Send a message to an agent                         |
| `debug_get_current_state`    | Inspect agent context, gather progress, flow state |
| `debug_traces`               | Search trace events (type, text, agent, error)     |
| `debug_session_history`      | Page durable Runtime sessions and persisted traces |
| `debug_get_span_tree`        | View hierarchical execution flow                   |
| `debug_explain_decision`     | Explain agent decisions with context               |
| `debug_get_flow_graph`       | View state machine graph (JSON or Mermaid)         |
| `debug_get_errors`           | Get errors, warnings, and escalations              |
| `debug_list_active_sessions` | List observable sessions                           |
| `debug_session`              | Subscribe/unsubscribe to session traces            |

#### Historical session analysis

`debug_session_history` is the explicit, read-only alternative when a retained session must be
analyzed after its live MCP buffer is unavailable. It works the same from Codex, Claude, and any
standards-compatible MCP client. Connect to the intended Runtime with `platform_connect` first so
the existing bearer identity, workspace, and environment remain authoritative.

List a first page (defaults are `limit: 50`, `offset: 0`, `sortBy: lastActivityAt`,
`sortDir: desc`):

```json
{ "action": "list", "projectId": "project-id", "status": ["completed"], "range": "7d" }
```

Read a middle or final trace page by advancing `offset`; a beyond-final page is an empty successful
page, not an error:

```json
{
  "action": "get",
  "projectId": "project-id",
  "sessionId": "session-id",
  "limit": 200,
  "offset": 200,
  "types": ["llm_call", "tool_call"]
}
```

Runtime controls retention, authorization, ordering, and the returned `_meta.source`,
`source_chain`, `is_truncated`, `warnings`, and `errors`. The tool makes one bounded request (2 MiB,
10 seconds), never probes another route, retries, silently converts a concealed 404 to an empty
page, hydrates live stores, or falls back from historical data to the MCP live buffer. Errors are
returned as bounded MCP errors; do not place credentials or secrets in filter values.

### Arch Analyze

Explain documentation, diagnostics, and system health signals.

| Tool                    | Description                                |
| ----------------------- | ------------------------------------------ |
| `debug_docs`            | Get or search ABL documentation            |
| `debug_diagnose`        | Diagnose agent config and execution issues |
| `debug_analyze_session` | Automated session diagnostics              |

## Authentication

Authentication is automatic when you call `platform_connect` — it tries, in order:

1. **Explicit token** — pass an `authToken` parameter.
2. **Stored credentials** — reads the same encrypted credential store used by `artemis-platform-cli login`.
3. **Device authorization** — opens your browser and polls until approval completes in the same `platform_connect` call.

Credentials are saved for reuse in future sessions.

## License

MIT — see [LICENSE](LICENSE).
