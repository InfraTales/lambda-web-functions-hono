/**
 * Per-request context.
 *
 * One Web Function environment serves up to 64 requests at the same time (128 if
 * you raise it). A module-level variable such as `let requestId` is shared by all
 * of them, so request A can log or return request B's value. AsyncLocalStorage
 * gives each request its own copy that survives every `await`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** One JSON line per call, tagged with the request it belongs to. */
export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, msg, requestId: currentRequestId(), ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}
