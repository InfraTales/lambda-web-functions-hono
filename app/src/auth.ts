import { createHash, timingSafeEqual } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const CACHE_MS = 5 * 60 * 1000;

/** Compares hashes, so the check takes the same time whatever the key's length or content. */
export function keyMatches(given: string | undefined, expected: string): boolean {
  if (!given || !expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Loads the API key from Secrets Manager on first use and keeps it for 5 minutes.
 * Concurrent requests in one environment share one in-flight read instead of each
 * calling Secrets Manager. A failed read isn't cached.
 */
export function cachedApiKey(client: SecretsManagerClient, secretId: string, now: () => number = Date.now) {
  let cached: { value: string; at: number } | undefined;
  let inFlight: Promise<string> | undefined;

  const load = async (): Promise<string> => {
    const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!res.SecretString) throw new Error('API key secret is empty');
    cached = { value: res.SecretString, at: now() };
    return res.SecretString;
  };

  return (): Promise<string> => {
    if (cached && now() - cached.at < CACHE_MS) return Promise.resolve(cached.value);
    inFlight ??= load().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
