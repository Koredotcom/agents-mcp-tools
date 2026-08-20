/**
 * Shared Constants
 *
 * Server URL is resolved from the AGENTS_URL env var.
 * If not set, defaults are undefined and platform_connect will require a serverUrl parameter.
 *
 * Examples:
 *   AGENTS_URL=https://agents.kore.ai        (production)
 *   AGENTS_URL=https://agents-dev.kore.ai     (dev)
 *   AGENTS_URL=https://agents-staging.kore.ai (staging)
 *   AGENTS_URL=https://agents-qa.kore.ai       (qa)
 */

import { deriveUrls } from './utils/url.js';

const envUrl = process.env.AGENTS_URL;
const derived = envUrl ? deriveUrls(envUrl) : undefined;

/** Default runtime HTTP URL (from AGENTS_URL env var) */
export const DEFAULT_HTTP_URL = derived?.httpUrl;

/** Default runtime WebSocket URL (from AGENTS_URL env var) */
export const DEFAULT_WS_URL = derived?.wsUrl;
