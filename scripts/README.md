# Project-builder release lanes

These runners provide process-level evidence for the public MCP project-building contract. They
are intentionally domain-neutral at the process and HTTP-fixture layers: workflow is the first MCP
provider exercised by the protocol test, while future providers reuse the same owned-service,
readiness, isolation, worktree, actor, and API-step machinery.

The runners never seed a database directly. A lane must use dev login and supported HTTP APIs. Each
service is started from an argv array without a shell, polled for at most 180 seconds, logged under
the configured report directory, and terminated as a runner-owned process group only if the runner
spawned it. Each service declares either an HTTP `readyUrl` or an argv-only `readyCommand`. Current
configs must own services named `mongo`, `redis`, `workflow-engine`, `runtime`, and `studio`; prior
configs must own `mongo`, `redis`, `runtime`, and `studio`.

## Commands

Build the package first, then pass an environment-owned JSON config. Do not commit credentials in a
config file.

```bash
pnpm --filter @koreai/arch-mcp-tools build
pnpm --filter @koreai/arch-mcp-tools test:e2e:project-builder -- --config /path/current.json
pnpm --filter @koreai/arch-mcp-tools test:e2e:project-builder:prior -- --config /path/prior.json
pnpm --filter @koreai/arch-mcp-tools test:e2e:project-builder:upgrade -- --config /path/upgrade.json
```

## Current lane

The config owns real current Studio, Runtime, Workflow Engine, Mongo, and Redis processes. Commands
may reference normal environment variables supplied by the release environment.

```json
{
  "lane": "current",
  "studioBaseUrl": "http://127.0.0.1:5173",
  "runtimeBaseUrl": "http://127.0.0.1:3112",
  "e2eEmail": "arch-project-builder@e2e-smoke.test",
  "isolation": {
    "mongoDatabase": "arch_project_builder_current",
    "redisNamespace": "arch-project-builder-current"
  },
  "services": [
    {
      "name": "mongo",
      "command": ["docker", "compose", "up", "mongo"],
      "readyCommand": ["mongosh", "--quiet", "--eval", "db.runCommand({ ping: 1 })"]
    },
    {
      "name": "redis",
      "command": ["docker", "compose", "up", "redis"],
      "readyCommand": ["redis-cli", "ping"]
    },
    {
      "name": "workflow-engine",
      "command": ["pnpm", "--filter", "@agent-platform/workflow-engine", "dev"],
      "readyUrl": "http://127.0.0.1:9080/health/ready",
      "env": {
        "PORT": "9080",
        "MONGODB_DATABASE": "arch_project_builder_current"
      }
    },
    {
      "name": "runtime",
      "command": ["pnpm", "--filter", "@agent-platform/runtime", "dev"],
      "readyUrl": "http://127.0.0.1:3112/health/live",
      "env": {
        "PORT": "3112",
        "HOST": "127.0.0.1",
        "MONGODB_DATABASE": "arch_project_builder_current"
      }
    },
    {
      "name": "studio",
      "command": ["pnpm", "--filter", "@agent-platform/studio", "dev"],
      "readyUrl": "http://127.0.0.1:5173/api/health",
      "env": {
        "PORT": "5173",
        "ENABLE_DEV_LOGIN": "true",
        "MONGODB_DATABASE": "arch_project_builder_current"
      }
    }
  ]
}
```

The release environment remains responsible for supplying the real isolated Mongo/Redis URLs and
all service dependencies. The named isolation fields are mandatory audit metadata and should match
those environment values. Set `MONGODB_DATABASE` explicitly on every current service even when the
database also appears in `MONGODB_URL`: the service registry default is an independent selector and
can otherwise route a lane back to the shared development database. Bind Runtime's `HOST` to the
same address used by `readyUrl`.

## Prior lane

The prior runner creates a runner-owned detached worktree at immutable commit
`0f4d97e3fe66cff58614be7ef38158db4d635c23`, verifies `HEAD`, optionally executes
the ordered `bootstrapCommands` (or the backward-compatible singular `bootstrapCommand`), starts
the declared services, and removes only that worktree on completion.
Use `${WORKTREE}` in service `cwd`, command arguments, or environment values. Prior Studio can run on
port 15173 because the built MCP receives an explicit `--studio-url`; Runtime and Studio no longer
need to share an origin for this lane.

The prior config has the current-lane shape plus:

```json
{
  "lane": "prior",
  "repositoryRoot": "../../..",
  "bootstrapCommands": [
    ["pnpm", "install", "--frozen-lockfile"],
    ["pnpm", "--filter", "@agent-platform/runtime^...", "build"],
    ["pnpm", "--filter", "@agent-platform/studio", "run", "ensure:workspace-dists"]
  ],
  "studioBaseUrl": "http://127.0.0.1:15173",
  "runtimeBaseUrl": "http://127.0.0.1:13112"
}
```

The MCP assertion requires the prior process to return `STUDIO_CAPABILITY_UNKNOWN`; it must not
infer project visibility from a missing capability route.

## Actor-upgrade lane

The upgrade config uses `services` for old processes and `currentServices` for current processes.
The old worktree is pinned separately to the last pre-enforcement workflow-builder commit
`baa4271749e2e06e19d32835cb27c5ec5eee9443`; the Artemis compatibility baseline does not contain
the workflow-build API and cannot create the grandfathered fixture. Mongo and Redis remain
runner-owned and live across the old-Studio → migrations → current-Studio transition; override
their default names with `transitionServiceNames` only when the config uses different service
names. The config also declares `currentStudioBaseUrl`, optional `currentRuntimeBaseUrl`, named
`actors`, `ownerActor`, optional `actorSetupCommands`, at least three `migrationCommands`
(preflight, migrate, post-migration verification), and four API-only step groups. Actor setup
commands run after the old fixture is created and receive actor/tenant variables; actor tokens are
then refreshed before current-version verification:

- `oldApiSteps`: create the grandfathered operation through the pinned old API.
- `verifyApiSteps`: prove current Studio can list/read it after registered migrations.
- `revokeApiSteps`: revoke project binding through the current API.
- `hiddenApiSteps`: prove the operation is immediately hidden afterward.

Each step supports `method`, `/api/...` `path`, named `actor`, JSON `body`, `expectedStatus`, and a
`capture` map from variable name to response path segments. Captured values and built-ins such as
`${PROJECT_ID}`, `${WORKTREE}`, and `${OWNER_ACTOR_ID}` can be used by later steps. This declarative
API transcript is reusable for future providers and avoids feature-specific database fixtures.

```json
{
  "actor": "owner",
  "method": "POST",
  "path": "/api/projects/${PROJECT_ID}/arch-workflow-builds",
  "body": {
    "goal": "Create an upgrade compatibility fixture",
    "requestedActorId": "${LEGACY_ACTOR_ID}"
  },
  "capture": { "OPERATION_ID": ["operation", "operationId"] }
}
```

All migration commands run against the same dedicated database after old services stop and before
current services start. Use the repository's registered preflight, migrate, and validate commands;
the runner deliberately provides no direct database mutation seam. The database must carry the
old baseline's real migration ledger (for example through a release-owned snapshot). A fresh
database makes every historical migration appear pending and may correctly stop on forward-only
approval policy; do not bypass that safeguard merely to reach the feature migration.
