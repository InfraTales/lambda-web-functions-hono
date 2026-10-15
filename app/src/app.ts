/**
 * The web app. Plain Hono: nothing in this file knows it runs on Lambda.
 *
 *   GET  /healthz       liveness, touches nothing else
 *   POST /api/links     create a short link (needs the x-api-key header)
 *   GET  /:slug         301 redirect, cacheable by CloudFront
 */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { currentRequestId, log, runWithContext } from './context';
import type { LinkStore } from './links';
import { isValidSlug, normalizeTarget } from './validate';
import { keyMatches } from './auth';

export interface AppDeps {
  store: LinkStore;
  getApiKey: () => Promise<string>;
  newSlug: () => string;
  now: () => Date;
}

// Links never change once created, so CloudFront can keep a redirect for a day.
// Browsers keep it for 5 minutes. A miss is cached briefly so a typo can't hammer the table.
export const REDIRECT_CACHE = 'public, max-age=300, s-maxage=86400';
export const NOT_FOUND_CACHE = 'public, max-age=60, s-maxage=60';
const NO_STORE = 'no-store';
const RANDOM_SLUG_ATTEMPTS = 3;

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // Lambda adds lambda-web-request-id to every request. Locally we make one up.
  app.use(async (c, next) => {
    const requestId = c.req.header('lambda-web-request-id') ?? randomUUID();
    const started = performance.now();
    await runWithContext({ requestId }, async () => {
      await next();
      // Read back from the context after the handler's awaits. If the context leaked
      // between concurrent requests, this is where it would show.
      c.header('x-request-id', currentRequestId() ?? 'missing');
      log('info', 'request', {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      });
    });
  });

  app.onError((err, c) => {
    log('error', 'unhandled error', { error: err instanceof Error ? err.message : String(err) });
    c.header('cache-control', NO_STORE);
    return c.json({ error: 'internal error' }, 500);
  });

  app.notFound((c) => {
    c.header('cache-control', NOT_FOUND_CACHE);
    return c.json({ error: 'not found' }, 404);
  });

  app.get('/healthz', (c) => {
    c.header('cache-control', NO_STORE);
    return c.json({ ok: true });
  });

  app.post(
    '/api/links',
    bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: 'body too large' }, 413) }),
    async (c) => {
      c.header('cache-control', NO_STORE);
      if (!keyMatches(c.req.header('x-api-key'), await deps.getApiKey())) {
        return c.json({ error: 'unauthorized' }, 401);
      }

      let body: { url?: unknown; slug?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'body must be JSON' }, 400);
      }
      const target = normalizeTarget(body.url);
      if (!target) return c.json({ error: 'url must be an http or https URL' }, 400);

      const createdAt = deps.now().toISOString();

      if (body.slug !== undefined) {
        if (typeof body.slug !== 'string' || !isValidSlug(body.slug)) {
          return c.json({ error: 'slug must be 3-32 letters, digits, - or _' }, 400);
        }
        const created = await deps.store.create({ slug: body.slug, target, createdAt });
        if (!created) return c.json({ error: 'slug already taken' }, 409);
        return c.json({ slug: body.slug, target }, 201);
      }

      for (let i = 0; i < RANDOM_SLUG_ATTEMPTS; i++) {
        const slug = deps.newSlug();
        if (await deps.store.create({ slug, target, createdAt })) return c.json({ slug, target }, 201);
        log('warn', 'random slug collision', { slug });
      }
      return c.json({ error: 'could not pick a free slug, try again' }, 503);
    },
  );

  app.get('/:slug', async (c) => {
    const slug = c.req.param('slug');
    const link = isValidSlug(slug) ? await deps.store.get(slug) : undefined;
    if (!link) {
      c.header('cache-control', NOT_FOUND_CACHE);
      return c.json({ error: 'not found' }, 404);
    }
    c.header('cache-control', REDIRECT_CACHE);
    return c.redirect(link.target, 301);
  });

  return app;
}
