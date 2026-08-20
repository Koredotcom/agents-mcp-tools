import { describe, expect, it } from 'vitest';
import {
  platformEvalPersonas,
  platformEvalRuns,
  platformEvalScenarios,
} from '../tools/platform-evals.js';
import type { DebugContext } from '../tools/index.js';
import type { StudioApiDependencies } from '../utils/studio-api.js';

interface FetchCall {
  url: string;
  options: RequestInit;
  timeoutMs: number;
}

interface FetchRecorder {
  calls: FetchCall[];
  dependencies: StudioApiDependencies;
}

const ctx = {
  httpClient: {
    getBaseUrl: () => 'http://localhost:3112',
    getAuthToken: () => 'token-123',
  },
} as unknown as DebugContext;

describe('platform eval tools', () => {
  it('builds eval run compare queries from structured runIds', async () => {
    const fetchRecorder = createFetchRecorder(jsonResponse({ success: true }));

    const raw = await platformEvalRuns(
      {
        action: 'compare',
        projectId: 'proj_123',
        runIds: ['run-a', 'run-b'],
      },
      ctx,
      fetchRecorder.dependencies,
    );

    expect(JSON.parse(raw)).toMatchObject({ success: true });
    expect(fetchRecorder.calls[0]).toMatchObject({
      url: 'http://localhost:5173/api/projects/proj_123/evals/runs/compare?runIds=run-a%2Crun-b',
      options: { method: 'GET' },
      timeoutMs: 15_000,
    });
  });

  it('rejects eval run compare without exactly two run IDs before calling Studio', async () => {
    const fetchRecorder = createFetchRecorder();

    const raw = await platformEvalRuns(
      {
        action: 'compare',
        projectId: 'proj_123',
        runIds: ['run-a'],
      },
      ctx,
      fetchRecorder.dependencies,
    );

    expect(JSON.parse(raw)).toMatchObject({
      success: false,
      error: 'runIds must contain exactly two run IDs for compare.',
    });
    expect(fetchRecorder.calls).toHaveLength(0);
  });

  it('rejects blank eval run compare IDs before calling Studio', async () => {
    const fetchRecorder = createFetchRecorder();

    const raw = await platformEvalRuns(
      {
        action: 'compare',
        projectId: 'proj_123',
        runIds: ['run-a', '   '],
      },
      ctx,
      fetchRecorder.dependencies,
    );

    expect(JSON.parse(raw)).toMatchObject({
      success: false,
      error: 'runIds must contain exactly two run IDs for compare.',
    });
    expect(fetchRecorder.calls).toHaveLength(0);
  });

  it('exposes AI persona and scenario generation endpoints for repair loops', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({ success: true }),
      jsonResponse({ success: true }),
    );

    await platformEvalPersonas(
      {
        action: 'generate',
        projectId: 'proj_123',
        body: { count: 2, focusAreas: ['handoff'] },
      },
      ctx,
      fetchRecorder.dependencies,
    );
    await platformEvalScenarios(
      {
        action: 'generate',
        projectId: 'proj_123',
        body: { count: 2, personaIds: ['persona-a'] },
      },
      ctx,
      fetchRecorder.dependencies,
    );

    expect(fetchRecorder.calls[0]).toMatchObject({
      url: 'http://localhost:5173/api/projects/proj_123/evals/generate/personas',
      options: { method: 'POST' },
      timeoutMs: 30_000,
    });
    expect(readCallBody(fetchRecorder, 0)).toEqual({ count: 2, focusAreas: ['handoff'] });
    expect(fetchRecorder.calls[1]).toMatchObject({
      url: 'http://localhost:5173/api/projects/proj_123/evals/generate/scenarios',
      options: { method: 'POST' },
      timeoutMs: 30_000,
    });
    expect(readCallBody(fetchRecorder, 1)).toEqual({ count: 2, personaIds: ['persona-a'] });
  });

  it('exposes eval preflight and quick-run workflow endpoints', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({ success: true }),
      jsonResponse({ success: true }),
    );

    await platformEvalRuns(
      { action: 'preflight', projectId: 'proj_123' },
      ctx,
      fetchRecorder.dependencies,
    );
    await platformEvalRuns(
      { action: 'quick', projectId: 'proj_123', body: { name: 'Smoke eval' } },
      ctx,
      fetchRecorder.dependencies,
    );

    expect(fetchRecorder.calls[0]).toMatchObject({
      url: 'http://localhost:5173/api/projects/proj_123/evals/preflight',
      options: { method: 'POST' },
      timeoutMs: 30_000,
    });
    expect(readCallBody(fetchRecorder, 0)).toEqual({});
    expect(fetchRecorder.calls[1]).toMatchObject({
      url: 'http://localhost:5173/api/projects/proj_123/evals/quick',
      options: { method: 'POST' },
      timeoutMs: 30_000,
    });
    expect(readCallBody(fetchRecorder, 1)).toEqual({ name: 'Smoke eval' });
  });

  it('sanitizes raw preflight diagnostics returned by older Studio deployments', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({
        success: true,
        result: {
          overall: 'warn',
          timestamp: '2026-05-21T00:00:00.000Z',
          checks: [
            {
              name: 'runtime_reachable',
              status: 'pass',
              message: 'Runtime at http://runtime:3112 is healthy',
              durationMs: 4.4,
            },
            {
              name: 'clickhouse',
              status: 'pass',
              message: 'ClickHouse eval_conversations table accessible',
              durationMs: 5,
            },
            {
              name: 'judge_token_split_schema',
              status: 'warn',
              message:
                'ClickHouse eval_scores is missing judge_input_tokens and judge_output_tokens columns',
              durationMs: 5.4,
            },
            {
              name: 'llm_credentials',
              status: 'fail',
              code: 'MISSING_PROVIDER_KEY',
              message: 'No OpenAI credential found for tenant tenant-1',
              durationMs: 6,
            },
            {
              name: 'provider_model_availability',
              status: 'fail',
              code: 'PROVIDER_MODEL_RETIRED',
              message:
                'Claude Sonnet 4 (claude-sonnet-4-20250514) is retired on the direct Anthropic API. Use claude-sonnet-4-6 before running evals.',
              durationMs: 6.4,
            },
            {
              name: 'runtime_auth',
              status: 'warn',
              message: 'Could not verify Runtime auth: JWT_SECRET mismatch',
              durationMs: 7,
            },
            {
              name: 'voice_runner',
              status: 'fail',
              message: 'Set EVAL_VOICE_EXECUTION_ENABLED=true for voice scenarios.',
              durationMs: 8,
            },
          ],
        },
      }),
    );

    const raw = await platformEvalRuns(
      { action: 'preflight', projectId: 'proj_123' },
      ctx,
      fetchRecorder.dependencies,
    );
    const body = JSON.parse(raw);

    expect(body).toMatchObject({
      success: true,
      data: {
        success: true,
        result: {
          overall: 'warn',
          checks: [
            {
              name: 'agent_service_connectivity',
              status: 'pass',
              message: 'Agent service is reachable.',
              durationMs: 4,
            },
            {
              name: 'results_storage',
              status: 'pass',
              message: 'Eval results storage is ready.',
              durationMs: 5,
            },
            {
              name: 'usage_telemetry',
              status: 'warn',
              message: 'Usage telemetry should be reviewed before evals run.',
              durationMs: 5,
            },
            {
              name: 'model_credentials',
              status: 'fail',
              code: 'MISSING_PROVIDER_KEY',
              message: 'Model credentials are missing for the selected provider.',
              durationMs: 6,
            },
            {
              name: 'model_configuration',
              status: 'fail',
              message: 'The selected evaluator model is retired; choose a supported model.',
              durationMs: 6,
            },
            {
              name: 'agent_service_authorization',
              status: 'warn',
              message: 'Agent service authorization should be reviewed before evals run.',
              durationMs: 7,
            },
            {
              name: 'voice_eval_execution',
              status: 'fail',
              message: 'Voice eval execution needs attention before voice evals can run.',
              durationMs: 8,
            },
          ],
        },
      },
    });

    const serializedBody = raw.toLowerCase();
    for (const leakedToken of [
      'clickhouse',
      'eval_conversations',
      'eval_scores',
      'judge_token_split_schema',
      'judge_input_tokens',
      'judge_output_tokens',
      'runtime_reachable',
      'runtime_auth',
      'llm_credentials',
      'provider_model_availability',
      'jwt_secret',
      'tenant-1',
      'claude-sonnet-4-20250514',
      'anthropic',
      'openai',
      'voice_runner',
      'eval_voice_execution_enabled',
    ]) {
      expect(serializedBody).not.toContain(leakedToken);
    }
  });

  it('exposes eval run case drill-down with diagnostic filters', async () => {
    const fetchRecorder = createFetchRecorder(jsonResponse({ success: true }));

    await platformEvalRuns(
      {
        action: 'cases',
        projectId: 'proj_123',
        runId: 'run-1',
        query: {
          view: 'diagnostic',
          failedOnly: true,
          evaluatorId: 'eval-1',
        },
      },
      ctx,
      fetchRecorder.dependencies,
    );

    expect(fetchRecorder.calls[0]).toMatchObject({
      url: 'http://localhost:5173/api/projects/proj_123/evals/runs/run-1/cases?view=diagnostic&failedOnly=true&evaluatorId=eval-1',
      options: { method: 'GET' },
      timeoutMs: 15_000,
    });
  });
});

function createFetchRecorder(...responses: Response[]): FetchRecorder {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fetchWithTimeout: StudioApiDependencies['fetchWithTimeout'] = async (
    url,
    options = {},
    timeoutMs = 5000,
  ) => {
    calls.push({ url, options, timeoutMs });
    return queue.shift() ?? jsonResponse({});
  };

  return {
    calls,
    dependencies: { fetchWithTimeout },
  };
}

function readCallBody<T = unknown>(fetchRecorder: FetchRecorder, index: number): T {
  return JSON.parse(fetchRecorder.calls[index]?.options.body as string) as T;
}

function jsonResponse(
  body: unknown,
  init: { status?: number; statusText?: string } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { 'Content-Type': 'application/json' },
  });
}
