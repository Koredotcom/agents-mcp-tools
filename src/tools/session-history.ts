import { z } from 'zod';

import { HttpResponseDecodeError, type BoundedHttpResult } from '../client/http-client.js';
import type {
  HistoryEnvelope,
  HistoryErrorEnvelope,
  HistoryGetResponse,
  HistoryListResponse,
  HistoryToolResult,
} from '../types.js';
import { ResponseSizeLimitError } from '../utils/bounded-response.js';
import { FetchError } from '../utils/fetch.js';
import { sanitizeResponseBounded } from '../utils/sanitize.js';
import type { DebugContext } from './index.js';
import type { JsonSchema } from '../project-building/contracts.js';

export const HISTORY_PAGE_MAX = 200;
export const HISTORY_ARRAY_MAX = 20;
export const HISTORY_FILTER_MAX_CHARS = 128;
export const HISTORY_ID_MAX_CHARS = 256;
export const HISTORY_LIST_SEARCH_MAX_CHARS = 256;
export const HISTORY_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
export const HISTORY_TIMEOUT_MS = 10_000;

const HISTORY_ERROR_CODE_MAX_CHARS = 128;
const HISTORY_ERROR_MESSAGE_MAX_CHARS = 512;

const boundedId = z.string().trim().min(1).max(HISTORY_ID_MAX_CHARS);
const boundedFilter = z.string().trim().min(1).max(HISTORY_FILTER_MAX_CHARS);
const boundedFilterList = z
  .array(
    boundedFilter.refine((value) => !value.includes(','), 'Filter values cannot contain commas'),
  )
  .min(1)
  .max(HISTORY_ARRAY_MAX);
const pagination = {
  limit: z.number().int().min(1).max(HISTORY_PAGE_MAX).default(50),
  offset: z.number().int().min(0).default(0),
};
const isoTimestamp = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .datetime({ offset: true, message: 'Expected a valid ISO 8601 timestamp' });

export const historyListSortFields = [
  'id',
  'agentName',
  'createdAt',
  'lastActivityAt',
  'messageCount',
  'traceEventCount',
  'errorCount',
  'tokenCount',
  'estimatedCost',
  'status',
  'environment',
  'channel',
] as const;

const historyStringSchema = (maxLength: number): JsonSchema => ({
  type: 'string',
  minLength: 1,
  maxLength,
});
const historyArraySchema: JsonSchema = {
  type: 'array',
  minItems: 1,
  maxItems: HISTORY_ARRAY_MAX,
  items: {
    ...historyStringSchema(HISTORY_FILTER_MAX_CHARS),
    pattern: '^[^,]+$',
  },
};
const historyPaginationSchema = {
  limit: { type: 'integer', minimum: 1, maximum: HISTORY_PAGE_MAX, default: 50 },
  offset: { type: 'integer', minimum: 0, default: 0 },
};

/** Exact MCP discovery contract; the generic Zod converter intentionally remains unchanged. */
export const SESSION_HISTORY_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'projectId'],
      properties: {
        action: { type: 'string', const: 'list' },
        projectId: historyStringSchema(HISTORY_ID_MAX_CHARS),
        ...historyPaginationSchema,
        status: historyArraySchema,
        channel: historyArraySchema,
        agentName: historyArraySchema,
        environment: historyArraySchema,
        disposition: historyStringSchema(HISTORY_FILTER_MAX_CHARS),
        outcome: historyStringSchema(HISTORY_FILTER_MAX_CHARS),
        q: historyStringSchema(HISTORY_LIST_SEARCH_MAX_CHARS),
        mine: { type: 'boolean' },
        from: { type: 'string', minLength: 1, maxLength: 64, format: 'date-time' },
        to: { type: 'string', minLength: 1, maxLength: 64, format: 'date-time' },
        range: {
          type: 'string',
          pattern: '^[1-9]\\d{0,4}d$',
          description: 'Relative lookback from 1d through 99999d; when set, from is ignored.',
        },
        sortBy: { type: 'string', enum: [...historyListSortFields], default: 'lastActivityAt' },
        sortDir: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'projectId', 'sessionId'],
      properties: {
        action: { type: 'string', const: 'get' },
        projectId: historyStringSchema(HISTORY_ID_MAX_CHARS),
        sessionId: historyStringSchema(HISTORY_ID_MAX_CHARS),
        ...historyPaginationSchema,
        types: historyArraySchema,
        eventType: historyStringSchema(HISTORY_FILTER_MAX_CHARS),
        spanId: historyStringSchema(HISTORY_FILTER_MAX_CHARS),
      },
    },
  ],
};

export const SESSION_HISTORY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const historyListSchema = z
  .object({
    action: z.literal('list'),
    projectId: boundedId,
    ...pagination,
    status: boundedFilterList.optional(),
    channel: boundedFilterList.optional(),
    agentName: boundedFilterList.optional(),
    environment: boundedFilterList.optional(),
    disposition: boundedFilter.optional(),
    outcome: boundedFilter.optional(),
    q: z.string().trim().min(1).max(HISTORY_LIST_SEARCH_MAX_CHARS).optional(),
    mine: z.boolean().optional(),
    from: isoTimestamp.optional(),
    to: isoTimestamp.optional(),
    range: z
      .string()
      .trim()
      .regex(/^[1-9]\d{0,4}d$/, 'Expected a range from 1d through 99999d')
      .optional(),
    sortBy: z.enum(historyListSortFields).default('lastActivityAt'),
    sortDir: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();

export const historyGetSchema = z
  .object({
    action: z.literal('get'),
    projectId: boundedId,
    sessionId: boundedId,
    ...pagination,
    types: boundedFilterList.optional(),
    eventType: boundedFilter.optional(),
    spanId: boundedFilter.optional(),
  })
  .strict();

export const sessionHistorySchema = z
  .discriminatedUnion('action', [historyListSchema, historyGetSchema])
  .superRefine((args, context) => {
    if (
      args.action === 'list' &&
      !args.range &&
      args.from &&
      args.to &&
      Date.parse(args.from) > Date.parse(args.to)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from'],
        message: 'from must be before or equal to to',
      });
    }
  });

type ParsedHistoryArgs = z.infer<typeof sessionHistorySchema>;

const historyRecordSchema = z.object({}).passthrough();
const nonNegativeInteger = z.number().int().min(0);
const historyDiagnosticSchema = z
  .object({
    source: z.string().min(1),
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .passthrough();
const historyMetaSchema = z
  .object({
    source: z.string().min(1),
    event_count: nonNegativeInteger,
    loaded_count: nonNegativeInteger.optional(),
    available_count: nonNegativeInteger.optional(),
    is_truncated: z.boolean(),
    source_chain: z.array(z.string()),
    warnings: z.array(historyDiagnosticSchema).optional(),
    errors: z.array(historyDiagnosticSchema).optional(),
  })
  .passthrough();
const historyListResponseSchema = z
  .object({
    success: z.literal(true),
    total: nonNegativeInteger,
    offset: nonNegativeInteger,
    limit: z.number().int().min(1).max(HISTORY_PAGE_MAX),
    sessions: z.array(historyRecordSchema).max(HISTORY_PAGE_MAX),
  })
  .passthrough();
const historyGetResponseSchema = z
  .object({
    success: z.literal(true),
    total: nonNegativeInteger,
    offset: nonNegativeInteger,
    limit: z.number().int().min(1).max(HISTORY_PAGE_MAX),
    traces: z.array(historyRecordSchema).max(HISTORY_PAGE_MAX),
    _meta: historyMetaSchema,
  })
  .passthrough();

export function buildSessionHistoryPath(args: ParsedHistoryArgs): string {
  const projectId = encodeURIComponent(args.projectId);
  const params = new URLSearchParams();
  params.set('limit', String(args.limit));
  params.set('offset', String(args.offset));

  if (args.action === 'get') {
    appendArray(params, 'types', args.types);
    appendValue(params, 'eventType', args.eventType);
    appendValue(params, 'spanId', args.spanId);
    return `/api/projects/${projectId}/sessions/${encodeURIComponent(args.sessionId)}/traces?${params.toString()}`;
  }

  appendArray(params, 'status', args.status);
  appendArray(params, 'channel', args.channel);
  appendArray(params, 'agentName', args.agentName);
  appendArray(params, 'environment', args.environment);
  appendValue(params, 'disposition', args.disposition);
  appendValue(params, 'outcome', args.outcome);
  appendValue(params, 'q', args.q);
  if (args.mine !== undefined) params.set('mine', String(args.mine));
  if (!args.range) appendValue(params, 'from', args.from);
  appendValue(params, 'to', args.to);
  appendValue(params, 'range', args.range);
  params.set('sortBy', args.sortBy);
  params.set('sortDir', args.sortDir);
  return `/api/projects/${projectId}/sessions?${params.toString()}`;
}

export async function sessionHistory(args: unknown, ctx: DebugContext): Promise<HistoryToolResult> {
  const parsed = sessionHistorySchema.parse(args);
  try {
    const response = await ctx.httpClient.getBoundedJson(buildSessionHistoryPath(parsed), {
      timeoutMs: HISTORY_TIMEOUT_MS,
      maxResponseBytes: HISTORY_RESPONSE_MAX_BYTES,
    });
    return createHistoryResult(normalizeHistoryResponse(parsed.action, response));
  } catch (error) {
    return createHistoryResult(normalizeHistoryFailure(error));
  }
}

function normalizeHistoryResponse(
  action: ParsedHistoryArgs['action'],
  response: BoundedHttpResult,
): HistoryEnvelope {
  if (response.status < 200 || response.status >= 300 || isUnsuccessfulBody(response.body)) {
    return normalizeHttpFailure(response);
  }

  const parsed =
    action === 'list'
      ? historyListResponseSchema.safeParse(response.body)
      : historyGetResponseSchema.safeParse(response.body);
  if (!parsed.success) {
    return historyError('MALFORMED_RESPONSE', 'Runtime returned a malformed history response.', {
      status: response.status,
    });
  }
  return parsed.data as HistoryListResponse | HistoryGetResponse;
}

function normalizeHttpFailure(response: BoundedHttpResult): HistoryErrorEnvelope {
  const fallbackCode = `HTTP_${response.status}`;
  const fallbackMessage = response.statusText || 'Runtime history request failed.';
  const body = asRecord(response.body);
  const rawError = body?.error;
  if (typeof rawError === 'string') {
    return historyError(fallbackCode, rawError, { status: response.status });
  }
  const error = asRecord(rawError);
  return historyError(
    typeof error?.code === 'string' ? error.code : fallbackCode,
    typeof error?.message === 'string' ? error.message : fallbackMessage,
    { status: response.status },
  );
}

function normalizeHistoryFailure(error: unknown): HistoryErrorEnvelope {
  if (error instanceof HttpResponseDecodeError) {
    return historyError('MALFORMED_RESPONSE', 'Runtime returned malformed JSON.', {
      status: error.status,
    });
  }
  if (error instanceof ResponseSizeLimitError) {
    return historyError('RESPONSE_TOO_LARGE', 'Runtime history response exceeded 2 MiB.');
  }
  if (error instanceof FetchError) {
    const code = error.code === 'UNKNOWN' ? 'NETWORK_ERROR' : error.code;
    return historyError(code, transportMessage(code));
  }
  return historyError('NETWORK_ERROR', 'Runtime history request failed.');
}

function historyError(
  code: string,
  message: string,
  options: { status?: number } = {},
): HistoryErrorEnvelope {
  return {
    success: false,
    error: {
      ...(options.status !== undefined ? { status: options.status } : {}),
      code: safeDiagnosticText(code, 'NETWORK_ERROR', HISTORY_ERROR_CODE_MAX_CHARS),
      message: safeDiagnosticText(
        message,
        'Runtime history request failed.',
        HISTORY_ERROR_MESSAGE_MAX_CHARS,
      ),
    },
  };
}

function createHistoryResult(envelope: HistoryEnvelope): HistoryToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    ...(envelope.success ? {} : { isError: true }),
  };
}

function safeDiagnosticText(value: string, fallback: string, maxLength: number): string {
  try {
    const sanitized = sanitizeResponseBounded(value.slice(0, maxLength), {
      maxStringLength: maxLength,
    });
    return typeof sanitized === 'string' && sanitized.length > 0
      ? sanitized.slice(0, maxLength)
      : fallback;
  } catch {
    return fallback;
  }
}

function transportMessage(code: string): string {
  switch (code) {
    case 'TIMEOUT':
      return 'Runtime history request timed out.';
    case 'CONNECTION_REFUSED':
      return 'Runtime history connection was refused.';
    case 'DNS_LOOKUP_FAILED':
      return 'Runtime history host could not be resolved.';
    default:
      return 'Runtime history network request failed.';
  }
}

function isUnsuccessfulBody(value: unknown): boolean {
  return asRecord(value)?.success === false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function appendArray(params: URLSearchParams, name: string, values?: string[]): void {
  if (values) params.set(name, values.join(','));
}

function appendValue(params: URLSearchParams, name: string, value?: string): void {
  if (value !== undefined) params.set(name, value);
}
