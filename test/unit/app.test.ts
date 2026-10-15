import { createApp, NOT_FOUND_CACHE, REDIRECT_CACHE } from '../../app/src/app';
import { FakeStore } from '../support/fake-store';

const KEY = 'test-key';

function setup(slugs: string[] = ['rand0001'], store = new FakeStore()) {
  const queue = [...slugs];
  const app = createApp({
    store,
    getApiKey: async () => KEY,
    newSlug: () => queue.shift() ?? 'rand9999',
    now: () => new Date('2026-10-15T00:00:00Z'),
  });
  const create = (body: unknown, key = KEY) =>
    app.request('/api/links', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { app, store, create };
}

describe('POST /api/links', () => {
  test('creates a link with a random slug', async () => {
    const { create, store } = setup();
    const res = await create({ url: 'https://example.com/docs' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ slug: 'rand0001', target: 'https://example.com/docs' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(store.links.get('rand0001')?.createdAt).toBe('2026-10-15T00:00:00.000Z');
  });

  test('creates a link with a chosen slug, and refuses to overwrite it', async () => {
    const { create, store } = setup();
    expect((await create({ url: 'https://a.example', slug: 'launch' })).status).toBe(201);
    const second = await create({ url: 'https://evil.example', slug: 'launch' });
    expect(second.status).toBe(409);
    expect(store.links.get('launch')?.target).toBe('https://a.example/');
  });

  test('retries a random slug that is taken, then gives up with 503', async () => {
    const { create, store } = setup(['taken', 'free1']);
    await store.create({ slug: 'taken', target: 'https://x.example/', createdAt: 'x' });
    expect(await (await create({ url: 'https://example.com' })).json()).toMatchObject({ slug: 'free1' });

    const crowded = setup(['aaa', 'aaa', 'aaa'], store);
    await store.create({ slug: 'aaa', target: 'https://x.example/', createdAt: 'x' });
    expect((await crowded.create({ url: 'https://example.com' })).status).toBe(503);
  });

  test.each([
    ['no key', undefined],
    ['wrong key', 'nope'],
    ['empty key', ''],
  ])('rejects %s with 401 before reading the body', async (_name, key) => {
    const { app, store } = setup();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key !== undefined) headers['x-api-key'] = key;
    const res = await app.request('/api/links', { method: 'POST', headers, body: '{"url":"https://example.com"}' });
    expect(res.status).toBe(401);
    expect(store.links.size).toBe(0);
  });

  test.each([
    ['javascript:alert(1)'],
    ['data:text/html,hi'],
    ['ftp://example.com/file'],
    ['https://user:pass@example.com'],
    ['not a url'],
    [`https://example.com/${'a'.repeat(2048)}`],
    [42],
  ])('rejects target %p with 400', async (url) => {
    const { create } = setup();
    expect((await create({ url })).status).toBe(400);
  });

  test.each([['ab'], ['has space'], ['api'], ['HEALTHZ'], ['x'.repeat(33)], [7]])('rejects slug %p with 400', async (slug) => {
    const { create } = setup();
    expect((await create({ url: 'https://example.com', slug })).status).toBe(400);
  });

  test('rejects a body that is not JSON', async () => {
    const { create } = setup();
    expect((await create('{nope')).status).toBe(400);
  });

  test('rejects a body over 4 KiB with 413', async () => {
    const { create } = setup();
    expect((await create({ url: 'https://example.com', pad: 'x'.repeat(5000) })).status).toBe(413);
  });
});

describe('GET /:slug', () => {
  test('redirects with 301 and a cache header CloudFront can use', async () => {
    const { app, create } = setup();
    await create({ url: 'https://example.com/a?b=1', slug: 'docs' });
    const res = await app.request('/docs');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://example.com/a?b=1');
    expect(res.headers.get('cache-control')).toBe(REDIRECT_CACHE);
  });

  test('HEAD works like GET', async () => {
    const { app, create } = setup();
    await create({ url: 'https://example.com', slug: 'docs' });
    expect((await app.request('/docs', { method: 'HEAD' })).status).toBe(301);
  });

  test('an unknown or invalid slug is a short-cached 404 and never reaches the table', async () => {
    const store = new FakeStore();
    const get = jest.spyOn(store, 'get');
    const { app } = setup([], store);
    for (const path of ['/missing', '/a', '/has.dot']) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe(NOT_FOUND_CACHE);
    }
    expect(get).toHaveBeenCalledTimes(1); // only "missing" is a valid slug
  });
});

describe('every response', () => {
  test('carries the Lambda request ID back as x-request-id', async () => {
    const { app } = setup();
    const res = await app.request('/healthz', { headers: { 'lambda-web-request-id': 'req-123' } });
    expect(res.headers.get('x-request-id')).toBe('req-123');
  });

  test('a store failure is a 500 with no detail and no caching', async () => {
    const store = new FakeStore();
    store.get = async () => { throw new Error('ProvisionedThroughputExceeded: table xyz'); };
    const { app } = setup([], store);
    const res = await app.request('/docs');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('/healthz does not touch the store', async () => {
    const store = new FakeStore();
    const get = jest.spyOn(store, 'get');
    const { app } = setup([], store);
    expect((await app.request('/healthz')).status).toBe(200);
    expect(get).not.toHaveBeenCalled();
  });
});
