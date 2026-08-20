import { describe, expect, it } from 'vitest';
import { platformImportExport } from '../tools/platform-import-export.js';
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

describe('platformImportExport', () => {
  it('auto-acknowledges non-blocking preview issues before import/apply', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({
        success: true,
        previewDigest: 'digest-1',
        preview: {
          hasBlockingIssues: false,
          issues: [
            { id: 'issue-warning', blocking: false, severity: 'warning' },
            { id: 'issue-info', blocking: false, severity: 'info' },
          ],
        },
      }),
      jsonResponse({ success: true, applied: true }),
    );

    const result = JSON.parse(
      await platformImportExport(
        {
          action: 'import',
          projectId: 'proj_123',
          confirm: true,
          files: {
            'project.json': '{"format_version":"2.0"}',
            'agents/support.agent.abl': 'AGENT: Support\nGOAL: "Help"',
          },
        },
        ctx,
        fetchRecorder.dependencies,
      ),
    ) as {
      success: boolean;
      data: {
        autoAcknowledgement: {
          previewDigest: string;
          acknowledgedIssueIds: string[];
          acknowledgedIssueCount: number;
        };
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.autoAcknowledgement).toEqual({
      previewDigest: 'digest-1',
      acknowledgedIssueIds: ['issue-warning', 'issue-info'],
      acknowledgedIssueCount: 2,
      nonBlockingIssueCount: 2,
    });

    expect(fetchRecorder.calls[0]).toMatchObject({
      url: 'http://localhost:5173/api/projects/proj_123/import/preview',
      options: { method: 'POST' },
      timeoutMs: 30_000,
    });
    expect(fetchRecorder.calls[1]).toMatchObject({
      url: 'http://localhost:5173/api/projects/proj_123/import/apply',
      options: { method: 'POST' },
      timeoutMs: 30_000,
    });

    const applyBody = readCallBody<{ previewDigest: string; acknowledgedIssueIds: string[] }>(
      fetchRecorder,
      1,
    );
    expect(applyBody).toMatchObject({
      previewDigest: 'digest-1',
      acknowledgedIssueIds: ['issue-warning', 'issue-info'],
    });
  });

  it('preserves server error bodies for import preview failures', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse(
        {
          success: false,
          error: {
            code: 'INVALID_LAYERS',
            message: 'Unsupported import layer(s): behavior_profiles',
          },
        },
        { status: 400, statusText: 'Bad Request' },
      ),
    );

    const result = JSON.parse(
      await platformImportExport(
        {
          action: 'import_preview',
          projectId: 'proj_123',
          files: {
            'project.json': '{"format_version":"2.0","layers_included":["behavior_profiles"]}',
          },
        },
        ctx,
        fetchRecorder.dependencies,
      ),
    ) as {
      success: boolean;
      status: number;
      body: { error: { code: string; message: string } };
    };

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.body.error).toEqual({
      code: 'INVALID_LAYERS',
      message: 'Unsupported import layer(s): behavior_profiles',
    });
    expect(fetchRecorder.calls).toHaveLength(1);
  });

  it('normalizes import-style data.files before sending import previews', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({
        success: true,
        preview: { hasBlockingIssues: false, issues: [] },
      }),
    );

    const result = JSON.parse(
      await platformImportExport(
        {
          action: 'import_preview',
          projectId: 'proj_123',
          data: {
            deleteUnmatched: true,
            files: {
              'wrapped-project/project.json': '{"format_version":"2.0"}',
              'wrapped-project/agents/support.agent.abl': 'AGENT: Support\nGOAL: "Help"',
            },
          },
        },
        ctx,
        fetchRecorder.dependencies,
      ),
    ) as {
      success: boolean;
      data: { warnings: string[]; source: { kind: string }; result: unknown };
    };

    expect(result.success).toBe(true);
    expect(result.data.warnings).toContain('Stripped common archive prefix "wrapped-project/".');
    expect(result.data.source).toEqual({ kind: 'inline' });

    const previewBody = readCallBody<{
      deleteUnmatched: boolean;
      files: Record<string, string>;
    }>(fetchRecorder, 0);
    expect(previewBody).toMatchObject({
      deleteUnmatched: true,
      files: {
        'project.json': '{"format_version":"2.0"}',
        'agents/support.agent.abl': 'AGENT: Support\nGOAL: "Help"',
      },
    });
  });

  it('does not apply imports when preview still has blocking issues', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({
        success: true,
        previewDigest: 'digest-blocked',
        preview: {
          hasBlockingIssues: true,
          issues: [
            { id: 'missing-profile', blocking: true, severity: 'error' },
            { id: 'non-blocking-warning', blocking: false, severity: 'warning' },
          ],
        },
      }),
    );

    const result = JSON.parse(
      await platformImportExport(
        {
          action: 'import',
          projectId: 'proj_123',
          confirm: true,
          files: {
            'project.json': '{"format_version":"2.0"}',
          },
        },
        ctx,
        fetchRecorder.dependencies,
      ),
    ) as { success: boolean; needsResolution: boolean; previewDigest: string };

    expect(result).toMatchObject({
      success: false,
      needsResolution: true,
      previewDigest: 'digest-blocked',
    });
    expect(fetchRecorder.calls).toHaveLength(1);
  });

  it('includes server response body when entry-agent patch fails after apply', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({
        success: true,
        previewDigest: 'digest-1',
        preview: {
          hasBlockingIssues: false,
          issues: [],
        },
      }),
      jsonResponse({ success: true, applied: true }),
      jsonResponse(
        {
          success: false,
          error: { code: 'PROJECT_LOCKED', message: 'Project is locked' },
        },
        { status: 423, statusText: 'Locked' },
      ),
    );

    const result = JSON.parse(
      await platformImportExport(
        {
          action: 'import',
          projectId: 'proj_123',
          confirm: true,
          files: {
            'project.json': '{"format_version":"2.0","entry_agent":"Support"}',
          },
        },
        ctx,
        fetchRecorder.dependencies,
      ),
    ) as { success: boolean; warning: string };

    expect(result.success).toBe(true);
    expect(result.warning).toContain('PROJECT_LOCKED');
    expect(result.warning).toContain('Project is locked');
    expect(fetchRecorder.calls[2]).toMatchObject({
      url: 'http://localhost:5173/api/projects/proj_123',
      options: { method: 'PATCH' },
      timeoutMs: 10_000,
    });
    expect(readCallBody<{ entryAgentName: string }>(fetchRecorder, 2)).toEqual({
      entryAgentName: 'Support',
    });
  });

  it('refuses auto-acknowledgement when preview issue IDs are missing', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({
        success: true,
        previewDigest: 'digest-unstable',
        preview: {
          hasBlockingIssues: false,
          nonBlockingIssueCount: 1,
          issues: [{ blocking: false, severity: 'warning' }],
        },
      }),
    );

    const result = JSON.parse(
      await platformImportExport(
        {
          action: 'import',
          projectId: 'proj_123',
          confirm: true,
          files: {
            'project.json': '{"format_version":"2.0"}',
          },
        },
        ctx,
        fetchRecorder.dependencies,
      ),
    ) as { success: boolean; error: string; nonBlockingIssueCount: number };

    expect(result).toMatchObject({
      success: false,
      nonBlockingIssueCount: 1,
    });
    expect(result.error).toContain('stable IDs');
    expect(fetchRecorder.calls).toHaveLength(1);
  });

  it('auto-previews when callers provide only a partial acknowledgement by default', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({
        success: true,
        previewDigest: 'fresh-digest',
        preview: {
          hasBlockingIssues: false,
          issues: [{ id: 'warning-id', blocking: false, severity: 'warning' }],
        },
      }),
      jsonResponse({ success: true, applied: true }),
    );

    const result = JSON.parse(
      await platformImportExport(
        {
          action: 'import',
          projectId: 'proj_123',
          confirm: true,
          previewDigest: 'stale-or-partial-digest',
          files: {
            'project.json': '{"format_version":"2.0"}',
          },
        },
        ctx,
        fetchRecorder.dependencies,
      ),
    ) as { success: boolean };

    expect(result.success).toBe(true);
    expect(
      readCallBody<{ previewDigest: string; acknowledgedIssueIds: string[] }>(fetchRecorder, 1),
    ).toMatchObject({
      previewDigest: 'fresh-digest',
      acknowledgedIssueIds: ['warning-id'],
    });
  });

  it('applies without a preview digest when preview has no acknowledgement-required issues', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({
        success: true,
        preview: {
          hasBlockingIssues: false,
          nonBlockingIssueCount: 0,
          issues: [],
        },
      }),
      jsonResponse({ success: true, applied: true }),
    );

    const result = JSON.parse(
      await platformImportExport(
        {
          action: 'import',
          projectId: 'proj_123',
          confirm: true,
          autoAcknowledgeNonBlocking: true,
          data: {
            previewDigest: 'stale-digest-from-caller',
            acknowledgedIssueIds: ['stale-warning-id'],
          },
          files: {
            'project.json': '{"format_version":"2.0"}',
          },
        },
        ctx,
        fetchRecorder.dependencies,
      ),
    ) as { success: boolean };

    expect(result.success).toBe(true);
    const previewBody = readCallBody<{
      previewDigest?: string;
      acknowledgedIssueIds?: string[];
    }>(fetchRecorder, 0);
    const applyBody = readCallBody<{
      previewDigest?: string;
      acknowledgedIssueIds: string[];
    }>(fetchRecorder, 1);
    expect(previewBody.previewDigest).toBeUndefined();
    expect(previewBody.acknowledgedIssueIds).toBeUndefined();
    expect(applyBody.previewDigest).toBeUndefined();
    expect(applyBody.acknowledgedIssueIds).toEqual([]);
  });

  it('rejects partial manual acknowledgements when auto-ack is disabled', async () => {
    const fetchRecorder = createFetchRecorder();

    const result = JSON.parse(
      await platformImportExport(
        {
          action: 'import',
          projectId: 'proj_123',
          confirm: true,
          previewDigest: 'digest-only',
          autoAcknowledgeNonBlocking: false,
          files: {
            'project.json': '{"format_version":"2.0"}',
          },
        },
        ctx,
        fetchRecorder.dependencies,
      ),
    ) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('requires both previewDigest and acknowledgedIssueIds');
    expect(fetchRecorder.calls).toHaveLength(0);
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
