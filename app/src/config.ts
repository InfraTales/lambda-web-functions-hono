/**
 * Lambda tells the server where to listen through AWS_LAMBDA_HTTP_ENDPOINT ("host:port").
 * When it's unset, we're running locally.
 */
export function listenAddress(env: NodeJS.ProcessEnv = process.env): { hostname: string; port: number } {
  const raw = env.AWS_LAMBDA_HTTP_ENDPOINT ?? `127.0.0.1:${env.PORT ?? '3000'}`;
  const i = raw.lastIndexOf(':');
  const port = Number(raw.slice(i + 1));
  if (i <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Bad listen address "${raw}", expected host:port`);
  }
  return { hostname: raw.slice(0, i), port };
}

/** Read once at startup, so a missing setting fails the environment before it takes traffic. */
export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
