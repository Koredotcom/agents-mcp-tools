import { describe, expect, it } from 'vitest';
import { debugLintAbl } from '../tools/debug-lint-abl.js';
import { debugWhyTranscriptFailed } from '../tools/debug-why-transcript-failed.js';
import type { DebugContext } from '../tools/index.js';
import { platformPackageModel } from '../tools/platform-package-model.js';
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

const data = {
  files: {
    'wrapped/project.json': '{"format_version":"2.0"}',
    'wrapped/agents/support.agent.abl': 'AGENT: Support\nGOAL: "Help"',
  },
};

describe('package repair MCP tools', () => {
  it.each([
    {
      name: 'debug_lint_abl',
      endpoint: '/api/abl/package/lint',
      response: { success: true, issues: [] },
      run: (dependencies: StudioApiDependencies) => debugLintAbl({ data }, ctx, dependencies),
    },
    {
      name: 'platform_package_model',
      endpoint: '/api/abl/package/model',
      response: { success: true, model: { agents: [] } },
      run: (dependencies: StudioApiDependencies) =>
        platformPackageModel({ data }, ctx, dependencies),
    },
    {
      name: 'debug_why_transcript_failed',
      endpoint: '/api/abl/package/diagnose-transcript',
      response: { success: true, diagnosis: { findings: [] } },
      run: (dependencies: StudioApiDependencies) =>
        debugWhyTranscriptFailed(
          { data, transcript: { steps: [{ type: 'finalize' }] } },
          ctx,
          dependencies,
        ),
    },
  ])('accepts import-style data.files payloads for $name', async ({ endpoint, response, run }) => {
    const fetchRecorder = createFetchRecorder(jsonResponse(response));

    expect(JSON.parse(await run(fetchRecorder.dependencies))).toMatchObject({ success: true });

    expect(fetchRecorder.calls).toHaveLength(1);
    expect(fetchRecorder.calls[0]).toMatchObject({
      url: `http://localhost:5173${endpoint}`,
      options: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost:5173',
          Authorization: 'Bearer token-123',
        },
      },
      timeoutMs: 30_000,
    });

    const body = readCallBody<{
      files: Record<string, string>;
      transcript?: { steps: Array<{ type: string }> };
    }>(fetchRecorder, 0);
    expect(body.files).toEqual({
      'project.json': '{"format_version":"2.0"}',
      'agents/support.agent.abl': 'AGENT: Support\nGOAL: "Help"',
    });
  });

  it('includes transcripts in transcript diagnosis requests', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({ success: true, diagnosis: { findings: [] } }),
    );

    await debugWhyTranscriptFailed(
      { data, transcript: { steps: [{ type: 'finalize' }] } },
      ctx,
      fetchRecorder.dependencies,
    );

    expect(
      readCallBody<{ transcript: { steps: Array<{ type: string }> } }>(fetchRecorder, 0).transcript,
    ).toEqual({
      steps: [{ type: 'finalize' }],
    });
  });

  it('promotes package model constraint observability to the MCP response top level', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({
        success: true,
        model: {
          agents: [],
          constraintObservability: {
            rawConstraints: 2,
            parsedConstraints: 0,
            compiledRuntimeConstraints: 0,
          },
          structuralSummary: {
            totals: {
              agents: 1,
              rawVsCompiledMismatches: 1,
            },
            rawVsCompiledMismatches: [
              {
                agent: 'Support',
                area: 'constraints',
                raw: 2,
                parsed: 0,
                compiled: 0,
              },
            ],
          },
        },
      }),
    );

    const result = JSON.parse(
      await platformPackageModel(
        {
          files: {
            'agents/support.agent.abl': 'AGENT: Support\nGOAL: "Help"',
          },
        },
        ctx,
        fetchRecorder.dependencies,
      ),
    ) as {
      constraintObservability: {
        rawConstraints: number;
        parsedConstraints: number;
        compiledRuntimeConstraints: number;
      };
      structuralSummary: {
        totals: { agents: number; rawVsCompiledMismatches: number };
      };
    };

    expect(result.constraintObservability).toEqual({
      rawConstraints: 2,
      parsedConstraints: 0,
      compiledRuntimeConstraints: 0,
    });
    expect(result.structuralSummary).toMatchObject({
      totals: {
        agents: 1,
        rawVsCompiledMismatches: 1,
      },
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

function readCallBody<T>(fetchRecorder: FetchRecorder, index: number): T {
  return JSON.parse(fetchRecorder.calls[index]?.options.body as string) as T;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': 'application/json' },
  });
}
