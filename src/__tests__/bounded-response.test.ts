import { describe, expect, test, vi } from 'vitest';
import {
  readBoundedResponseBytes,
  readBoundedResponseJson,
  readBoundedResponseText,
  ResponseSizeLimitError,
} from '../utils/bounded-response.js';

describe('bounded HTTP responses', () => {
  test('reads bounded text and JSON responses, including empty bodies', async () => {
    await expect(readBoundedResponseText(new Response('hello'), 5)).resolves.toBe('hello');
    await expect(readBoundedResponseJson(new Response('{"ok":true}'), 32)).resolves.toEqual({
      ok: true,
    });
    await expect(readBoundedResponseJson(new Response('  '), 2)).resolves.toBeNull();
    await expect(readBoundedResponseBytes(new Response(null), 1)).resolves.toEqual(
      new Uint8Array(),
    );
  });

  test('rejects an oversized declared content length before reading the body', async () => {
    const response = new Response('small', {
      headers: { 'content-length': '100' },
    });

    await expect(readBoundedResponseBytes(response, 5)).rejects.toEqual(
      expect.objectContaining<ResponseSizeLimitError>({
        name: 'ResponseSizeLimitError',
        message: 'HTTP response exceeded the 5-byte limit.',
      }),
    );
  });

  test('ignores a malformed declared length and enforces the streamed byte limit', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('123'));
        controller.enqueue(new TextEncoder().encode('456'));
      },
      cancel,
    });
    const response = new Response(stream, {
      headers: { 'content-length': 'not-a-number' },
    });

    await expect(readBoundedResponseBytes(response, 5)).rejects.toBeInstanceOf(
      ResponseSizeLimitError,
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});
