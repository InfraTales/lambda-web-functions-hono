/**
 * Runs build/web/index.js the way the Web Function runtime does: a separate Node
 * process with AWS_LAMBDA_HTTP_ENDPOINT set, which must start listening within 10 seconds.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import * as path from 'node:path';

export const BUNDLE = path.join(__dirname, '..', '..', 'build', 'web', 'index.js');

export interface RunningFunction {
  url: string;
  proc: ChildProcess;
  logs: string[];
  startupMs: number;
  stop: () => Promise<number | null | 'hung'>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

export async function startWebFunction(env: Record<string, string>): Promise<RunningFunction> {
  const port = await freePort();
  const started = Date.now();
  const logs: string[] = [];
  const proc = spawn(process.execPath, ['--enable-source-maps', BUNDLE], {
    env: {
      PATH: process.env.PATH,
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      AWS_LAMBDA_HTTP_ENDPOINT: `127.0.0.1:${port}`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const listening = new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        logs.push(line);
        if (line.includes('"msg":"listening"')) resolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.once('exit', (code) => reject(new Error(`exited with ${code} before listening:\n${logs.join('\n')}`)));
    setTimeout(() => reject(new Error(`not listening after 10 s:\n${logs.join('\n')}`)), 10_000).unref();
  });
  await listening;

  return {
    url: `http://127.0.0.1:${port}`,
    proc,
    logs,
    startupMs: Date.now() - started,
    // Sends SIGTERM like Lambda does. If the process is still alive after 2 seconds it
    // has failed the shutdown contract: kill it and report 'hung' so the test fails fast.
    stop: () =>
      new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve(proc.exitCode);
        const deadline = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve('hung');
        }, 2000);
        proc.once('exit', (code) => {
          clearTimeout(deadline);
          resolve(code);
        });
        proc.kill('SIGTERM');
      }),
  };
}
