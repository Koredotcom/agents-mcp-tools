import { describe, expect, it } from 'vitest';
import { platformValidatePackage } from '../tools/platform-validate-package.js';
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

describe('platformValidatePackage', () => {
  it('accepts import-style data.files payloads for validator/import-preview parity', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({
        diagnostics: {
          valid: true,
          issues: [],
          constraintObservability: {
            rawConstraints: 1,
            parsedConstraints: 1,
            compiledRuntimeConstraints: 1,
          },
          structuralSummary: {
            totals: {
              agents: 1,
              rawVsCompiledMismatches: 0,
            },
          },
        },
      }),
      jsonResponse({
        success: true,
        preview: {
          hasBlockingIssues: false,
          nonBlockingIssueCount: 0,
          issues: [],
        },
      }),
    );

    const result = JSON.parse(
      await platformValidatePackage(
        {
          projectId: 'proj_123',
          data: {
            deleteUnmatched: false,
            files: {
              'project.json': '{"format_version":"2.0"}',
            },
          },
        },
        ctx,
        fetchRecorder.dependencies,
      ),
    ) as {
      success: boolean;
      constraintObservability: {
        rawConstraints: number;
        parsedConstraints: number;
        compiledRuntimeConstraints: number;
      };
      importPreview: { canApply: boolean };
      structuralSummary: {
        totals: { agents: number; rawVsCompiledMismatches: number };
      };
    };

    expect(result.success).toBe(true);
    expect(result.constraintObservability).toEqual({
      rawConstraints: 1,
      parsedConstraints: 1,
      compiledRuntimeConstraints: 1,
    });
    expect(result.importPreview.canApply).toBe(true);
    expect(result.structuralSummary).toMatchObject({
      totals: { agents: 1, rawVsCompiledMismatches: 0 },
    });

    const validateBody = readCallBody<{ files: Record<string, string> }>(fetchRecorder, 0);
    const previewBody = readCallBody<{
      deleteUnmatched: boolean;
      files: Record<string, string>;
    }>(fetchRecorder, 1);

    expect(fetchRecorder.calls).toEqual([
      {
        url: 'http://localhost:5173/api/abl/package/validate',
        options: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'http://localhost:5173',
            Authorization: 'Bearer token-123',
          },
          body: JSON.stringify({ files: { 'project.json': '{"format_version":"2.0"}' } }),
        },
        timeoutMs: 30_000,
      },
      {
        url: 'http://localhost:5173/api/projects/proj_123/import/preview',
        options: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'http://localhost:5173',
            Authorization: 'Bearer token-123',
          },
          body: JSON.stringify({
            deleteUnmatched: false,
            files: { 'project.json': '{"format_version":"2.0"}' },
          }),
        },
        timeoutMs: 30_000,
      },
    ]);
    expect(validateBody.files).toEqual({ 'project.json': '{"format_version":"2.0"}' });
    expect(previewBody).toMatchObject({
      deleteUnmatched: false,
      files: { 'project.json': '{"format_version":"2.0"}' },
    });
  });

  it.each([
    {
      name: 'apply-ready acknowledgement args when preview issues are fully identifiable',
      previewBody: {
        success: true,
        previewDigest: 'digest-1',
        preview: {
          hasBlockingIssues: false,
          nonBlockingIssueCount: 1,
          issues: [{ id: 'warning-1', blocking: false, severity: 'warning' }],
        },
      },
      expected: {
        canApply: true,
        acknowledgementReady: true,
        missingAcknowledgementIssueIdCount: 0,
        suggestedApplyArgs: {
          previewDigest: 'digest-1',
          acknowledgedIssueIds: ['warning-1'],
        },
      },
    },
    {
      name: 'incomplete acknowledgement when issue IDs or digest are missing',
      previewBody: {
        success: true,
        preview: {
          hasBlockingIssues: false,
          nonBlockingIssueCount: 1,
          issues: [{ blocking: false, severity: 'warning' }],
        },
      },
      expected: {
        canApply: false,
        acknowledgementReady: false,
        missingAcknowledgementIssueIdCount: 1,
        suggestedApplyArgs: undefined,
      },
    },
  ])('$name', async ({ previewBody, expected }) => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({ valid: true, issues: [] }),
      jsonResponse(previewBody),
    );

    const result = JSON.parse(
      await platformValidatePackage(
        {
          projectId: 'proj_123',
          files: {
            'project.json': '{"format_version":"2.0"}',
          },
        },
        ctx,
        fetchRecorder.dependencies,
      ),
    ) as {
      success: boolean;
      importPreview: {
        canApply: boolean;
        acknowledgementReady: boolean;
        missingAcknowledgementIssueIdCount: number;
        suggestedApplyArgs?: { previewDigest: string; acknowledgedIssueIds: string[] };
      };
    };

    expect(result.success).toBe(true);
    expect(result.importPreview).toMatchObject({
      canApply: expected.canApply,
      acknowledgementReady: expected.acknowledgementReady,
      missingAcknowledgementIssueIdCount: expected.missingAcknowledgementIssueIdCount,
    });
    expect(result.importPreview.suggestedApplyArgs).toEqual(expected.suggestedApplyArgs);
    expect(fetchRecorder.calls.map((call) => call.timeoutMs)).toEqual([30_000, 30_000]);
  });

  it('returns validator failures without requesting import preview', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({ error: 'Invalid package' }, { status: 400, statusText: 'Bad Request' }),
    );

    const result = JSON.parse(
      await platformValidatePackage(
        {
          projectId: 'proj_123',
          data: {
            deleteUnmatched: false,
            files: {
              'project.json': '{"format_version":"2.0"}',
            },
          },
        },
        ctx,
        fetchRecorder.dependencies,
      ),
    ) as {
      success: boolean;
      error: string;
      status: number;
    };

    expect(result).toMatchObject({
      success: false,
      status: 400,
    });
    expect(result.error).toContain('/api/abl/package/validate failed');
    expect(fetchRecorder.calls).toHaveLength(1);
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
