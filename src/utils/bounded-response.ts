const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;

export class ResponseSizeLimitError extends Error {
  constructor(maxBytes: number) {
    super(`HTTP response exceeded the ${maxBytes}-byte limit.`);
    this.name = 'ResponseSizeLimitError';
  }
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<string> {
  return new TextDecoder().decode(await readBoundedResponseBytes(response, maxBytes));
}

export async function readBoundedResponseBytes(
  response: Response,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      throw new ResponseSizeLimitError(maxBytes);
    }
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new ResponseSizeLimitError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readBoundedResponseJson(
  response: Response,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<unknown> {
  const text = await readBoundedResponseText(response, maxBytes);
  return text.trim() ? (JSON.parse(text) as unknown) : null;
}
