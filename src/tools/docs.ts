/**
 * Documentation Tools
 *
 * debug_docs - Get or search Agent ABL documentation via the Studio API.
 * Requires an active platform connection (platform_connect).
 */

import { z } from 'zod';
import { deriveStudioUrl } from '../utils/studio-api.js';
import { fetchWithTimeout } from '../utils/fetch.js';
import type { DebugContext } from './index.js';
import { ABL_DOCS, DOC_TOPICS, searchDocumentation } from '../docs/index.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const FETCH_TIMEOUT_MS = 10_000;

// =============================================================================
// HELPERS
// =============================================================================

function buildHeaders(ctx: DebugContext): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = ctx.httpClient.getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

function error(message: string, detail?: string): string {
  return JSON.stringify({ success: false, error: message, ...(detail ? { detail } : {}) }, null, 2);
}

function embeddedList(detail?: string): string {
  return JSON.stringify(
    {
      source: 'embedded',
      availableTopics: DOC_TOPICS,
      total: DOC_TOPICS.length,
      ...(detail ? { detail } : {}),
      hint: 'These are MCP fallback topics. Connect to Studio for the full documentation index.',
    },
    null,
    2,
  );
}

function embeddedTopic(topic: string, detail?: string): string | null {
  const content = ABL_DOCS[topic];
  const meta = DOC_TOPICS.find((entry) => entry.id === topic);
  if (!content || !meta) {
    return null;
  }

  return JSON.stringify(
    {
      source: 'embedded',
      topic: meta.id,
      title: meta.title,
      category: meta.category,
      content,
      ...(detail ? { detail } : {}),
    },
    null,
    2,
  );
}

function embeddedSearch(query: string, detail?: string): string {
  const results = searchDocumentation(query);
  return JSON.stringify(
    {
      source: 'embedded',
      query,
      resultCount: results.length,
      results,
      ...(detail ? { detail } : {}),
      ...(results.length === 0
        ? {
            hint: 'No embedded fallback results. Connect to Studio for the full documentation index.',
          }
        : {}),
    },
    null,
    2,
  );
}

// =============================================================================
// REMOTE DOCS (Studio API)
// =============================================================================

interface TopicMeta {
  id: string;
  title: string;
  category: string;
}

interface RemoteTopicResult {
  success: boolean;
  topic?: { id: string; title: string; category: string; content: string };
  error?: string;
}

interface RemoteIndexResult {
  success: boolean;
  topics?: TopicMeta[];
}

interface RemoteSearchResult {
  success: boolean;
  results?: Array<{ id: string; title: string; excerpt: string }>;
}

export interface DocsDependencies {
  fetchWithTimeout: typeof fetchWithTimeout;
}

const defaultDocsDependencies: DocsDependencies = {
  fetchWithTimeout,
};

async function apiFetch<T>(
  url: string,
  headers: Record<string, string>,
  dependencies: DocsDependencies,
): Promise<T> {
  const res = await dependencies.fetchWithTimeout(url, { headers }, FETCH_TIMEOUT_MS);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ''}`);
  }
  return res.json() as Promise<T>;
}

// =============================================================================
// SCHEMA
// =============================================================================

export const docsSchema = z.object({
  topic: z
    .string()
    .optional()
    .describe(
      'Documentation topic to retrieve full content for. Use without arguments to list all available topics.',
    ),
  query: z.string().optional().describe('Search term to find across all documentation topics'),
});

export type DocsArgs = z.infer<typeof docsSchema>;

// =============================================================================
// HANDLER
// =============================================================================

export async function docs(
  args: DocsArgs,
  ctx: DebugContext,
  dependencies: DocsDependencies = defaultDocsDependencies,
): Promise<string> {
  const { topic, query } = args;

  const baseUrl = ctx.httpClient.getBaseUrl();
  if (!baseUrl) {
    if (topic) {
      return (
        embeddedTopic(topic, 'Not connected to Studio; showing embedded MCP fallback docs.') ??
        embeddedList('Not connected to Studio; requested topic is not embedded.')
      );
    }
    if (query) {
      return embeddedSearch(query, 'Not connected to Studio; showing embedded MCP fallback docs.');
    }
    return embeddedList('Not connected to Studio; showing embedded MCP fallback docs.');
  }

  const headers = buildHeaders(ctx);
  if (!headers['Authorization']) {
    if (topic) {
      return (
        embeddedTopic(
          topic,
          'Not authenticated with Studio; showing embedded MCP fallback docs.',
        ) ?? embeddedList('Not authenticated with Studio; requested topic is not embedded.')
      );
    }
    if (query) {
      return embeddedSearch(
        query,
        'Not authenticated with Studio; showing embedded MCP fallback docs.',
      );
    }
    return embeddedList('Not authenticated with Studio; showing embedded MCP fallback docs.');
  }

  const studioBase = deriveStudioUrl(baseUrl);

  // ── LIST TOPICS ──────────────────────────────────────────────────────────
  if (!topic && !query) {
    try {
      const data = await apiFetch<RemoteIndexResult>(
        `${studioBase}/api/abl/docs`,
        headers,
        dependencies,
      );
      if (data.success && data.topics) {
        return JSON.stringify(
          {
            source: 'api',
            availableTopics: data.topics,
            total: data.topics.length,
            embeddedFallbackTopics: DOC_TOPICS,
            hint: 'Provide a "topic" (by id) to get full content, or a "query" to search across all topics.',
          },
          null,
          2,
        );
      }
      return error('API returned no topics.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return embeddedList(`Failed to list Studio topics: ${msg}`);
    }
  }

  // ── GET TOPIC ────────────────────────────────────────────────────────────
  if (topic) {
    try {
      const safeTopic = encodeURIComponent(topic);
      const data = await apiFetch<RemoteTopicResult>(
        `${studioBase}/api/abl/docs?topic=${safeTopic}`,
        headers,
        dependencies,
      );
      if (data.success && data.topic) {
        return JSON.stringify(
          {
            source: 'api',
            topic: data.topic.id,
            title: data.topic.title,
            category: data.topic.category,
            content: data.topic.content,
          },
          null,
          2,
        );
      }
      return (
        embeddedTopic(topic, `Studio topic "${topic}" was not found; showing embedded fallback.`) ??
        error(`Topic "${topic}" not found.`, 'Use debug_docs without arguments to list topics.')
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return (
        embeddedTopic(topic, `Failed to fetch Studio topic "${topic}": ${msg}`) ??
        error(
          `Failed to fetch topic "${topic}": ${msg}`,
          'Ensure Studio is running and you are authenticated (platform_connect).',
        )
      );
    }
  }

  // ── SEARCH ───────────────────────────────────────────────────────────────
  if (query) {
    try {
      const safeQuery = encodeURIComponent(query);
      const data = await apiFetch<RemoteSearchResult>(
        `${studioBase}/api/abl/docs?search=${safeQuery}`,
        headers,
        dependencies,
      );
      if (data.success && data.results) {
        const embeddedResults = searchDocumentation(query);
        return JSON.stringify(
          {
            source: 'api',
            query,
            resultCount: data.results.length + embeddedResults.length,
            results: [...data.results, ...embeddedResults],
            embeddedFallbackResultCount: embeddedResults.length,
          },
          null,
          2,
        );
      }
      return embeddedSearch(
        query,
        'Studio search returned no results; showing embedded fallback search.',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return embeddedSearch(query, `Studio search failed: ${msg}`);
    }
  }

  return error('Provide a "topic" or "query" parameter.');
}
