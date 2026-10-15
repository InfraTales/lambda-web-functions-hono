export const SLUG = /^[A-Za-z0-9_-]{3,32}$/;
export const MAX_URL_LENGTH = 2048;
/** Paths the app owns. A link can't take them over. */
const RESERVED = new Set(['api', 'healthz', 'favicon.ico', 'robots.txt']);

export function isValidSlug(slug: string): boolean {
  return SLUG.test(slug) && !RESERVED.has(slug.toLowerCase());
}

/**
 * Only plain http(s) links. Rejects javascript:, data: and file: URLs, and URLs with
 * a user name or password in them, which are a common phishing trick.
 */
export function normalizeTarget(input: unknown): string | undefined {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_URL_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username || url.password) return undefined;
  return url.toString();
}
