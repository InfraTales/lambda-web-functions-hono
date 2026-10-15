/**
 * Measures CPU time per request for the real bundle, against DynamoDB Local.
 * Web Functions bill active CPU time, so this is the number the cost model needs.
 * It's a laptop measurement: use it for the order of magnitude, then check your
 * own numbers in CloudWatch after a deploy.
 *
 *   AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8000 npx ts-node scripts/measure-cpu.ts
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { startFakeSecretsManager } from '../test/support/fake-secrets-manager';
import { startWebFunction } from '../test/support/web-function';

const N = 5000;
const CONCURRENCY = 32;

function cpuSeconds(pid: number): number {
  // ps prints cumulative CPU time as [[dd-]hh:]mm:ss.cc
  const t = execFileSync('ps', ['-o', 'time=', '-p', String(pid)]).toString().trim();
  return t.split(/[-:]/).map(Number).reduce((acc, part) => acc * 60 + part, 0);
}

async function run(label: string, pid: number, one: (i: number) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < 200; i++) await one(i); // warm up the JIT and connections
  const before = cpuSeconds(pid);
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < N) await one(next++);
  }));
  const ms = ((cpuSeconds(pid) - before) * 1000) / N;
  console.log(`${label}: ${ms.toFixed(2)} ms CPU per request (${N} requests, ${CONCURRENCY} at a time)`);
}

async function main(): Promise<void> {
  const endpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB;
  if (!endpoint) throw new Error('Set AWS_ENDPOINT_URL_DYNAMODB');
  const table = `cpu-${randomUUID()}`;
  await new DynamoDBClient({
    region: 'us-east-1',
    endpoint,
    credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
  }).send(new CreateTableCommand({
    TableName: table,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'slug', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'slug', KeyType: 'HASH' }],
  }));
  const secrets = await startFakeSecretsManager('k');
  const fn = await startWebFunction({
    LINKS_TABLE: table,
    API_KEY_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:k',
    AWS_ENDPOINT_URL_DYNAMODB: endpoint,
    AWS_ENDPOINT_URL_SECRETS_MANAGER: secrets.url,
  });
  const pid = fn.proc.pid!;
  const post = (body: unknown) =>
    fetch(`${fn.url}/api/links`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: JSON.stringify(body) });
  await post({ url: 'https://example.com/a', slug: 'hot' });

  await run('redirect (GET /:slug, one DynamoDB read)', pid, () => fetch(`${fn.url}/hot`, { redirect: 'manual' }).then((r) => r.arrayBuffer()));
  await run('create (POST /api/links, one DynamoDB write)', pid, (i) => post({ url: `https://example.com/${i}` }).then((r) => r.arrayBuffer()));

  await fn.stop();
  await secrets.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
