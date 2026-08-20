# SOP → ABL Repair & Convergence Playbook (for AI agents)

This is the repair methodology for driving a Kore.ai Agent Platform project from a
source-of-truth SOP to a **verified runtime behavior target** using the
`arch-agent-platform` MCP tools. It is **offline-first**: source artifacts, ABL,
deterministic validators, runtime transcripts, and judge evidence are the inner loop;
importing/promoting to the live product is a final step, not the diagnosis loop.

You (Codex / Claude / another agent) may edit ABL directly — but every patch must be
**source-backed, generic for the scenario family, and regression-tested**.

## Operating principles

| Principle                     | Rule                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source authority              | SOP + structured scenario contracts are the source of truth. No SOP → curated evals are truth. Neither → user requirements are truth, and gaps are documented. |
| Behavior over aggregate score | Steer by layer/scenario/transcript/runtime-error movement. The average score is a summary, not the steering signal.                                            |
| Fast offline loop             | Run static + focused runtime validators before the full matrix. Full matrix only after the candidate is structurally safe.                                     |
| No symptom whack-a-mole       | Group all current failures, classify by layer, then patch the highest-leverage behavior layer.                                                                 |
| Reversible changes            | Every candidate stores before/after ABL, validation reports, transcripts, and a rollback point.                                                                |
| Gated target                  | A 95% behavior goal requires high score, high judged coverage, zero critical runtime errors, and no safety/write-action regressions.                           |

## How this maps to the MCP tools

| Loop step                                           | MCP tools                                                                                                            |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Static validate + compiler model + dependency graph | `platform_validate_package`, `platform_package_model`, `debug_lint_abl`                                              |
| Runtime smoke + transcripts + flow graph            | `debug_load_agent`, `debug_send_message`, `debug_traces`, `debug_get_span_tree`, `debug_get_flow_graph`              |
| Root-cause a failing layer                          | `debug_diagnose`, `debug_why_transcript_failed`, `debug_explain_decision`, `debug_get_errors`                        |
| Full matrix + judge evidence                        | `platform_eval_scenarios` / `_personas` / `_evaluators` / `_sets`, `platform_eval_runs` (start/status/heatmap/cases) |
| Apply the surgical ABL patch                        | `platform_agents` (`save_dsl`)                                                                                       |
| Promote to the product                              | `platform_import_export`, `platform_versions`, `platform_deployments`                                                |

Always call `platform_connect` first (see `agents.md`).

## The convergence loop

1. Normalize the source contract for the target scenario family.
2. Generate or repair the **smallest** behavior surface that can move one known layer.
3. Validate static safety **and** dependency-graph completeness.
4. Run focused runtime transcripts for the touched layer + adjacent paths.
5. Compare judge reasons and **layer deltas** (not just the score).
6. **Lock** the improved layer before expanding scope.
7. Run the full matrix only once the candidate is structurally safe.
8. Accept / rollback / refine, then add fixed scenarios to a regression lock.

### Steer by layers, not the average

Track movement per layer: routing/path, tool action, data contract, response
obligation, safety, runtime stability. Also track judged coverage and locked-layer
regressions.

- A **flat aggregate score can be progress** if a blocker was peeled and no locked layer
  regressed (the next surfaced failure is deeper/more concrete).
- A **rising score is not progress** if judged coverage dropped or runtime errors rose.
- Scores are only comparable when scenario set, evaluator set, judged coverage, fixtures,
  and runtime mode match — report scenario count, judgment count, and runtime-error count
  next to every score.

### Classify every finding by owner

`SOP issue` · `tool issue` · `generation issue` · `model issue` · `Arch/Codex prompt issue`
· `validation/materialization issue` · `eval issue` · `judge LLM issue` · `runtime issue`
· `other:<label>`. If a contract field is missing, **compile or ask for it** — do not ask
the model to re-guess.

## Source: SOP → scenario contract

An SOP is an operating contract, not a prompt. Normalize it into per-scenario contracts
before generating ABL. Each scenario should carry:

```yaml
scenario:
  id: string
  userMessage: string
  expectedPath: string[] # supervisor + specialists
  routeIntent: string
  requiredContextFields: string[]
  requiredToolOrder: string[]
  toolFixtures: ToolFixture[] # input-aware, scenario-bound, incl. negative cases
  expectedOutcome:
    fields: string[]
    customerTextMustInclude: string[]
    forbiddenClaims: string[]
  mustNot: string[]
```

Every tool needs a structured contract: `sideEffects`, `requiredInputs`, `optionalInputs`,
`outputs`, `callWhen`, `doNotCallWhen`, and (for writes) a `confirmation` phrase.

## ABL authoring rules

**Do**

- Route supervisors through native `INTENTS` + `intent.category` + `HANDOFF`.
- Give each specialist one capability and only its tools.
- Bind every tool input to a proven producer before the call.
- Gate side-effect tools behind policy checks + user confirmation.
- Return structured child outputs to the supervisor; render customer responses from typed
  outcome fields (decision, reference, ETA/window, denial reason, next step).
- Keep user-facing text free of internal agent/tool names, raw variables, and unresolved
  templates.
- Keep scenario IDs stable across regeneration and repair.

**Don't**

- No `GATHER routing_category` and no asking users to pick an internal intent.
- No prose decisions in `SET` variables the runtime can't execute.
- No write tool firing with missing required inputs.
- No returning from a child without mapping required output fields.
- No custom supervisor `FLOW` when native handoff semantics suffice.
- No domain-keyword heuristics in validators or repair rules.
- No accepting a patch on a flat score if it adds runtime errors or safety regressions.

## Validation layers (each has a failure owner)

| Layer                | Checks                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| SOP completeness     | Missing owner, path, tool order, expected outcome, fixture.                                                   |
| Scenario contract    | Fields are structured and executable.                                                                         |
| ABL syntax/compile   | Parse, references, step targets, expressions.                                                                 |
| Dependency graph     | Producers/consumers for tool inputs, memory, handoff returns — on every reachable path (incl. handoff entry). |
| Tool action contract | Right tool for intent, tool order, write preconditions.                                                       |
| Response obligation  | Customer sees decision, reference, denial reason, next step.                                                  |
| Runtime smoke        | No runtime errors, loops, or blank responses.                                                                 |
| Judge calibration    | Ideal transcript scores high; bad transcript scores low.                                                      |
| Full matrix          | Broad behavior, safety, path, completion, coverage.                                                           |

**Calibrate the judge before optimizing against it.** Hand-author an ideal transcript for
a representative failing scenario and confirm it scores in the target band; otherwise the
score doesn't measure the behavior you want.

## Patch acceptance

| Accept when                                                        | Reject / rollback when                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------- |
| Blocking findings drop with no new safety/runtime blockers.        | Runtime errors rise or judged coverage drops below threshold.  |
| A scenario moves from wrong action → correct action.               | Patch only changes wording while tool/path stays wrong.        |
| A data-producer gap closes and the tool call stays correct.        | Patch invents ungrounded values or hides missing producers.    |
| A response now includes outcome fields/next step.                  | Patch exposes internal/tool details or unresolved variables.   |
| A target layer improves even if the aggregate is temporarily flat. | Patch overfits one scenario by damaging broader role behavior. |

Repair must be **surgical or lossless** — never round-trip untouched ABL through a lossy
IR (it silently drops persona, tool returns, prompts, and memory types).

## 95% target is gated

Not a simple average. All must hold: behavior score ≥ 95% on the weighted metric; ≥ 98%
of matrix cells judged (unjudged explained); zero critical runtime errors; 100% pass on
safety/write-action preconditions; ≥ 95% executable-scenario pass rate; all regression
locks pass; human/cross-model transcript spot-check; judge still calibrated.

## Codex operating rules

- Read the SOP/scenario contract, current ABL, latest transcripts, judge analysis, and
  layer report **before** editing.
- State the root cause and planned behavior change before patching.
- Patch the smallest set of ABL files that owns the layer.
- Validate uncertain constructs with parser/compiler/runtime before relying on them.
- Run offline validators after each patch; store the diff + decision; update the
  regression list when a scenario is fixed.
- Ask for human input only when source truth is missing or contradictory (SOP silent on a
  scenario, eval conflicts with SOP, tool contract lacks I/O, judge penalizes an ideal
  source-faithful transcript, or a genuinely ambiguous product-policy choice).

## Stop and redesign (don't keep patching) when

- The same layer produces variant failures after several fixes (representation is wrong).
- Judge calibration fails, so the score no longer measures desired behavior.
- Fixtures are generic or contradict the scenario premise.
- The runtime can't express the behavior without fragile custom flows.
- Direct ABL patches keep requiring whole-project rewrites.
- The SOP lacks the authority to decide correct behavior.

---

The full internal runbook (with multi-day convergence learnings and workspace layout)
lives in the monorepo at `docs/arch-ai/offline-sop-to-abl-codex-loop.md`.
