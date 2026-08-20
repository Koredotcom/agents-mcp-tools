const SENSITIVE_KEYS =
  /^(api[_-]?key|x[_-]?api[_-]?key|secret|password|token|authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|credential|private[_-]?key|access[_-]?key|client[_-]?secret|(access|refresh|id|bearer)[_-]?token)$/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.test(key);
}

function containsSensitiveText(value: string): boolean {
  return (
    /\b(?:bearer|basic)\s+[^\s,;]+/i.test(value) ||
    /\b(?:api[_-]?key|x[_-]?api[_-]?key|secret|credential|private[_-]?key|access[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer[_-]?token|authorization|proxy[_-]?authorization|password|token|cookie|set[_-]?cookie)\s*[:=]\s*[^\s,;]+/i.test(
      value,
    ) ||
    /https?:\/\/[^\s/@:]+:[^\s/@]+@/i.test(value)
  );
}

export function findSensitiveFieldPath(value: unknown, prefix = ''): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSensitiveFieldPath(value[index], `${prefix}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'string') return containsSensitiveText(value) ? prefix || '$' : null;
  if (typeof value !== 'object' || value === null) return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isSensitiveKey(key)) return path;
    const found = findSensitiveFieldPath(child, path);
    if (found) return found;
  }
  return null;
}

export function sanitizeResponse(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') return redactSensitiveText(data);
  if (typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map(sanitizeResponse);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = sanitizeResponse(value);
    }
  }
  return result;
}

export interface BoundedSanitizerOptions {
  maxDepth?: number;
  maxArrayItems?: number;
  maxObjectKeys?: number;
  maxStringLength?: number;
}

const BOUNDED_DEFAULTS: Required<BoundedSanitizerOptions> = {
  maxDepth: 12,
  maxArrayItems: 100,
  maxObjectKeys: 100,
  maxStringLength: 16_384,
};

export function findSensitiveFieldPathBounded(
  value: unknown,
  options: BoundedSanitizerOptions = {},
): string | null {
  const limits = { ...BOUNDED_DEFAULTS, ...options };
  const ancestors = new Set<object>();

  function visit(current: unknown, path: string, depth: number): string | null {
    assertTraversalBound(current, depth, limits);
    if (typeof current === 'string') return containsSensitiveText(current) ? path || '$' : null;
    if (current === null || typeof current !== 'object') return null;
    if (ancestors.has(current)) return null;
    ancestors.add(current);
    for (const [key, child] of safeEntries(current, limits.maxObjectKeys)) {
      const childPath = Array.isArray(current) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
      if (isSensitiveKey(key)) return childPath;
      const found = visit(child, childPath, depth + 1);
      if (found) return found;
    }
    ancestors.delete(current);
    return null;
  }

  return visit(value, '', 0);
}

export function sanitizeResponseBounded(
  value: unknown,
  options: BoundedSanitizerOptions = {},
): unknown {
  const limits = { ...BOUNDED_DEFAULTS, ...options };
  const ancestors = new Set<object>();

  function visit(current: unknown, depth: number): unknown {
    assertTraversalBound(current, depth, limits);
    if (typeof current === 'string') return redactSensitiveText(current);
    if (current === null || typeof current !== 'object') return current;
    if (ancestors.has(current)) return '[CIRCULAR]';
    ancestors.add(current);
    const result: Record<string, unknown> | unknown[] = Array.isArray(current) ? [] : {};
    for (const [key, child] of safeEntries(current, limits.maxObjectKeys)) {
      const sanitized = isSensitiveKey(key) ? '[REDACTED]' : visit(child, depth + 1);
      if (Array.isArray(result)) result.push(sanitized);
      else result[key] = sanitized;
    }
    ancestors.delete(current);
    return result;
  }

  return visit(value, 0);
}

function assertTraversalBound(
  value: unknown,
  depth: number,
  limits: Required<BoundedSanitizerOptions>,
): void {
  if (depth > limits.maxDepth) throw new Error('Sanitizer maximum depth exceeded');
  if (typeof value === 'string' && value.length > limits.maxStringLength) {
    throw new Error('Sanitizer maximum string length exceeded');
  }
  if (Array.isArray(value) && value.length > limits.maxArrayItems) {
    throw new Error('Sanitizer maximum array items exceeded');
  }
}

function safeEntries(value: object, maxEntries: number): Array<[string, unknown]> {
  if (Array.isArray(value)) return value.map((child, index) => [String(index), child]);
  const entries: Array<[string, unknown]> = [];
  if (value instanceof Error) {
    entries.push(['name', value.name], ['message', value.message]);
  }
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (value instanceof Error && (key === 'name' || key === 'message')) continue;
    if (entries.length >= maxEntries) throw new Error('Sanitizer maximum object keys exceeded');
    try {
      entries.push([key, (value as Record<string, unknown>)[key]]);
    } catch {
      entries.push([key, '[UNREADABLE]']);
    }
  }
  if (entries.length > maxEntries) throw new Error('Sanitizer maximum object keys exceeded');
  return entries;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(cookie|set[_-]?cookie)\s*[:=]\s*[^\r\n]+/gi, '$1=[REDACTED]')
    .replace(/\b(bearer|basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(
      /\b(api[_-]?key|x[_-]?api[_-]?key|secret|credential|private[_-]?key|access[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer[_-]?token|authorization|proxy[_-]?authorization|password|token|cookie|set[_-]?cookie)\s*[:=]\s*([^\s,;]+)/gi,
      '$1=[REDACTED]',
    )
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}
