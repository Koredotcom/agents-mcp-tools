import { describe, expect, it } from 'vitest';
import { platformArchAutoLoop } from '../tools/platform-arch-auto-loop.js';
import { platformArchSop } from '../tools/platform-arch-sop.js';
import { getTool } from '../tools/index.js';
import { getArchCapabilityForTool } from '../tools/persona.js';
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

describe('platform Arch workflow MCP exposure', () => {
  it('registers SOP-build and Auto Loop tools in the MCP tool registry', () => {
    expect(getTool('platform_arch_sop')).toBeDefined();
    expect(getTool('platform_arch_auto_loop')).toBeDefined();
    expect(getArchCapabilityForTool('platform_arch_sop')).toBe('Build');
    expect(getArchCapabilityForTool('platform_arch_auto_loop')).toBe('Optimize');
  });

  it('creates Arch SOP sessions through the Studio API', async () => {
    const fetchRecorder = createFetchRecorder(jsonResponse({ sessionId: 'arch-session-1' }));

    const raw = await platformArchSop(
      {
        action: 'create_session',
        projectId: 'proj_123',
        forceNew: true,
        threadId: 'sop-thread',
      },
      createContext('https://agents-dev.kore.ai'),
      fetchRecorder.dependencies,
    );

    expect(JSON.parse(raw)).toMatchObject({ success: true });
    expect(fetchRecorder.calls).toEqual([
      {
        url: 'https://agents-dev.kore.ai/api/arch-ai/sessions',
        options: {
          method: 'POST',
          headers: studioHeaders(),
          body: JSON.stringify({
            projectId: 'proj_123',
            forceNew: true,
            threadId: 'sop-thread',
          }),
        },
        timeoutMs: 30_000,
      },
    ]);
  });

  it('sends SOP-build instructions through the Arch message stream endpoint', async () => {
    const fetchRecorder = createFetchRecorder(textResponse('event: done\ndata: {"ok":true}\n\n'));

    const raw = await platformArchSop(
      {
        action: 'send_message',
        sessionId: 'arch-session-1',
        text: 'Create a project from this SOP and preserve source-backed routing.',
      },
      createContext('http://localhost:3112'),
      fetchRecorder.dependencies,
    );

    expect(JSON.parse(raw)).toMatchObject({
      success: true,
      data: 'event: done\ndata: {"ok":true}\n\n',
    });
    expect(fetchRecorder.calls[0]).toMatchObject({
      url: 'http://localhost:5173/api/arch-ai/message',
      options: {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-123',
          'Content-Type': 'application/json',
          Origin: 'http://localhost:5173',
        },
      },
      timeoutMs: 120_000,
    });
    expect(JSON.parse(String(fetchRecorder.calls[0]?.options.body))).toEqual({
      sessionId: 'arch-session-1',
      type: 'message',
      text: 'Create a project from this SOP and preserve source-backed routing.',
    });
  });

  it('uploads SOP files and references their blobs in Arch messages', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({ data: { blobId: 'blob-sop-1' } }),
      textResponse('event: done\ndata: {"ok":true}\n\n'),
    );

    await platformArchSop(
      {
        action: 'upload_file',
        sessionId: 'arch-session-1',
        file: {
          name: 'source-sop.md',
          type: 'text/markdown',
          size: 12,
          content: Buffer.from('# SOP\nRoute.').toString('base64'),
        },
      },
      createContext('https://agents-dev.kore.ai'),
      fetchRecorder.dependencies,
    );
    await platformArchSop(
      {
        action: 'send_message',
        sessionId: 'arch-session-1',
        text: 'Create a project from this SOP.',
        fileRefs: [{ blobId: 'blob-sop-1' }],
      },
      createContext('https://agents-dev.kore.ai'),
      fetchRecorder.dependencies,
    );

    expect(fetchRecorder.calls[0]).toMatchObject({
      url: 'https://agents-dev.kore.ai/api/arch-ai/files',
      options: { method: 'POST', headers: studioHeaders() },
      timeoutMs: 60_000,
    });
    expect(JSON.parse(String(fetchRecorder.calls[0]?.options.body))).toEqual({
      sessionId: 'arch-session-1',
      file: {
        name: 'source-sop.md',
        type: 'text/markdown',
        size: 12,
        content: Buffer.from('# SOP\nRoute.').toString('base64'),
      },
    });
    expect(JSON.parse(String(fetchRecorder.calls[1]?.options.body))).toEqual({
      sessionId: 'arch-session-1',
      type: 'message',
      text: 'Create a project from this SOP.',
      fileRefs: [{ blobId: 'blob-sop-1' }],
    });
  });

  it('drives Arch create-project through the message contract', async () => {
    const fetchRecorder = createFetchRecorder(textResponse('event: done\ndata: {}\n\n'));

    await platformArchSop(
      { action: 'create_project', sessionId: 'arch:session:1' },
      createContext('https://agents-dev.kore.ai'),
      fetchRecorder.dependencies,
    );

    expect(fetchRecorder.calls[0]).toMatchObject({
      url: 'https://agents-dev.kore.ai/api/arch-ai/message',
      timeoutMs: 120_000,
    });
    expect(JSON.parse(String(fetchRecorder.calls[0]?.options.body))).toEqual({
      sessionId: 'arch:session:1',
      type: 'create',
    });
  });

  it('lists and creates Arch Auto Loop runs through project-scoped Studio APIs', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({ runs: [] }),
      jsonResponse({ run: { id: 'auto-loop-1' } }),
    );

    await platformArchAutoLoop(
      { action: 'list', projectId: 'proj_123' },
      createContext('https://agents-dev.kore.ai'),
      fetchRecorder.dependencies,
    );
    await platformArchAutoLoop(
      {
        action: 'create',
        projectId: 'proj_123',
        body: { sourceEvalSetId: 'eval-set-1', config: { maxIterations: 3 } },
      },
      createContext('https://agents-dev.kore.ai'),
      fetchRecorder.dependencies,
    );

    expect(fetchRecorder.calls[0]).toMatchObject({
      url: 'https://agents-dev.kore.ai/api/projects/proj_123/arch-auto-loop/runs',
      options: { method: 'GET', headers: studioHeaders() },
      timeoutMs: 15_000,
    });
    expect(fetchRecorder.calls[1]).toMatchObject({
      url: 'https://agents-dev.kore.ai/api/projects/proj_123/arch-auto-loop/runs',
      options: { method: 'POST', headers: studioHeaders() },
      timeoutMs: 60_000,
    });
    expect(JSON.parse(String(fetchRecorder.calls[1]?.options.body))).toEqual({
      sourceEvalSetId: 'eval-set-1',
      config: { maxIterations: 3 },
    });
  });

  it('executes Auto Loop actions and records decisions against the run endpoints', async () => {
    const fetchRecorder = createFetchRecorder(jsonResponse({ run: {} }), jsonResponse({ run: {} }));

    await platformArchAutoLoop(
      {
        action: 'execute_action',
        projectId: 'proj_123',
        runId: 'run_123',
        body: { actionId: 'run_runtime_eval', stageId: 'runtime_eval', reason: 'MCP smoke' },
      },
      createContext('https://agents-dev.kore.ai'),
      fetchRecorder.dependencies,
    );
    await platformArchAutoLoop(
      {
        action: 'record_decision',
        projectId: 'proj_123',
        runId: 'run_123',
        body: {
          decisionKind: 'accept',
          stageId: 'runtime_eval',
          targetType: 'gate',
          targetId: 'gate-1',
          reason: 'Reviewed through MCP',
        },
      },
      createContext('https://agents-dev.kore.ai'),
      fetchRecorder.dependencies,
    );

    expect(fetchRecorder.calls[0]?.url).toBe(
      'https://agents-dev.kore.ai/api/projects/proj_123/arch-auto-loop/runs/run_123/actions',
    );
    expect(fetchRecorder.calls[1]?.url).toBe(
      'https://agents-dev.kore.ai/api/projects/proj_123/arch-auto-loop/runs/run_123/decisions',
    );
  });

  it('validates missing IDs before calling Studio', async () => {
    const fetchRecorder = createFetchRecorder(jsonResponse({}));

    const raw = await platformArchAutoLoop(
      { action: 'get', projectId: 'proj_123' },
      createContext('https://agents-dev.kore.ai'),
      fetchRecorder.dependencies,
    );

    expect(JSON.parse(raw)).toEqual({
      success: false,
      error: 'runId is required for this action.',
    });
    expect(fetchRecorder.calls).toHaveLength(0);
  });
});

function createContext(baseUrl: string): DebugContext {
  return {
    httpClient: {
      getBaseUrl: () => baseUrl,
      getAuthToken: () => 'token-123',
    },
  } as DebugContext;
}

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

function studioHeaders(origin = 'https://agents-dev.kore.ai'): Record<string, string> {
  return {
    Authorization: 'Bearer token-123',
    'Content-Type': 'application/json',
    Origin: origin,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
