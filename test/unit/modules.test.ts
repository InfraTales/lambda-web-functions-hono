import { mockClient } from 'aws-sdk-client-mock';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { cachedApiKey, keyMatches } from '../../app/src/auth';
import { listenAddress, requireEnv } from '../../app/src/config';
import { currentRequestId, runWithContext } from '../../app/src/context';
import { randomSlug } from '../../app/src/slug';

describe('listenAddress', () => {
  test('reads host:port from AWS_LAMBDA_HTTP_ENDPOINT', () => {
    expect(listenAddress({ AWS_LAMBDA_HTTP_ENDPOINT: '169.254.100.1:9001' })).toEqual({ hostname: '169.254.100.1', port: 9001 });
  });
  test('falls back to 127.0.0.1 and PORT locally', () => {
    expect(listenAddress({ PORT: '8080' })).toEqual({ hostname: '127.0.0.1', port: 8080 });
  });
  test.each(['nohost', ':9000', 'host:0', 'host:abc', 'host:70000'])('rejects %p', (v) => {
    expect(() => listenAddress({ AWS_LAMBDA_HTTP_ENDPOINT: v })).toThrow('Bad listen address');
  });
});

describe('requireEnv', () => {
  test('throws on a missing or empty value', () => {
    expect(() => requireEnv('X', {})).toThrow('Missing required environment variable X');
    expect(() => requireEnv('X', { X: '' })).toThrow('X');
    expect(requireEnv('X', { X: 'v' })).toBe('v');
  });
});

describe('keyMatches', () => {
  test('matches only the exact key', () => {
    expect(keyMatches('secret', 'secret')).toBe(true);
    expect(keyMatches('secret ', 'secret')).toBe(false);
    expect(keyMatches('a-much-longer-guess', 'secret')).toBe(false);
    expect(keyMatches(undefined, 'secret')).toBe(false);
    expect(keyMatches('', '')).toBe(false);
  });
});

describe('cachedApiKey', () => {
  const sm = mockClient(SecretsManagerClient);
  beforeEach(() => sm.reset());

  test('concurrent first calls share one read, then the value is cached for 5 minutes', async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: 'k1' });
    let t = 0;
    const get = cachedApiKey(new SecretsManagerClient({}), 'arn', () => t);
    expect(await Promise.all(Array.from({ length: 50 }, () => get()))).toEqual(Array(50).fill('k1'));
    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(1);
    t = 4 * 60_000;
    await get();
    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(1);
    t = 6 * 60_000;
    await get();
    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(2);
  });

  test('a failed read is not cached', async () => {
    sm.on(GetSecretValueCommand).rejectsOnce(new Error('throttled')).resolves({ SecretString: 'k1' });
    const get = cachedApiKey(new SecretsManagerClient({}), 'arn');
    await expect(get()).rejects.toThrow('throttled');
    expect(await get()).toBe('k1');
  });

  test('an empty secret is an error', async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: '' });
    await expect(cachedApiKey(new SecretsManagerClient({}), 'arn')()).rejects.toThrow('empty');
  });
});

describe('request context', () => {
  test('each concurrent async flow keeps its own request ID across awaits', async () => {
    const seen = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        runWithContext({ requestId: `r${i}` }, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          return currentRequestId();
        }),
      ),
    );
    expect(seen).toEqual(Array.from({ length: 100 }, (_, i) => `r${i}`));
  });
});

describe('randomSlug', () => {
  test('8 characters from an alphabet without look-alikes', () => {
    for (let i = 0; i < 200; i++) expect(randomSlug()).toMatch(/^[a-km-np-zA-HJ-NP-Z2-9]{8}$/);
  });

  test('throws away bytes that would bias the result', () => {
    // 255 is above the cut-off for a 56-letter alphabet; 0 maps to "a".
    const bytes = jest.fn((n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i % 2 ? 0 : 255))));
    expect(randomSlug(bytes)).toBe('aaaaaaaa');
  });
});
