/**
 * The real bundle (build/web/index.js), run the way the Web Function runtime runs it,
 * against DynamoDB Local. These cover what only shows up in a real server process:
 * many requests sharing one environment, races on one slug, startup and shutdown.
 *
 * Needs AWS_ENDPOINT_URL_DYNAMODB, for example http://localhost:8000 (see README, "Tests").
 */
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { startFakeSecretsManager } from '../support/fake-secrets-manager';
import { startWebFunction, type RunningFunction } from '../support/web-function';

const dynamoEndpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB;
if (!dynamoEndpoint) throw new Error('Set AWS_ENDPOINT_URL_DYNAMODB, for example http://localhost:8000');

const KEY = `key-${randomUUID()}`;
const table = `links-${randomUUID()}`;
const ddb = new DynamoDBClient({
  region: 'us-east-1',
  endpoint: dynamoEndpoint,
  credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
});
let secrets: Awaited<ReturnType<typeof startFakeSecretsManager>>;
let fn: RunningFunction;

const env = () => ({
  LINKS_TABLE: table,
  API_KEY_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:api-key',
  AWS_ENDPOINT_URL_DYNAMODB: dynamoEndpoint,
  AWS_ENDPOINT_URL_SECRETS_MANAGER: secrets.url,
});

const create = (body: unknown, key = KEY) =>
  fetch(`${fn.url}/api/links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  await ddb.send(new CreateTableCommand({
    TableName: table,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'slug', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'slug', KeyType: 'HASH' }],
  }));
  secrets = await startFakeSecretsManager(KEY);
  fn = await startWebFunction(env());
});

afterAll(async () => {
  await fn?.stop();
  await secrets?.close();
  await ddb.send(new DeleteTableCommand({ TableName: table }));
  ddb.destroy();
});

test('starts listening well inside the 10 second limit', () => {
  // Lambda fails the environment if the server isn't listening within 10 s.
  expect(fn.startupMs).toBeLessThan(3000);
});

test('the first burst of requests shares one Secrets Manager read', async () => {
  const before = secrets.calls();
  const results = await Promise.all(Array.from({ length: 30 }, () => create({ url: 'https://example.com/burst' })));
  expect(results.every((r) => r.status === 201)).toBe(true);
  expect(secrets.calls() - before).toBe(1);
});

test('create, then redirect, over real HTTP', async () => {
  const res = await create({ url: 'https://example.com/guide', slug: 'guide' });
  expect(res.status).toBe(201);
  const hop = await fetch(`${fn.url}/guide`, { redirect: 'manual' });
  expect(hop.status).toBe(301);
  expect(hop.headers.get('location')).toBe('https://example.com/guide');
  expect(hop.headers.get('cache-control')).toContain('s-maxage=86400');
});

test('wrong API key: 401, nothing written', async () => {
  expect((await create({ url: 'https://example.com', slug: 'sneaky' }, 'guess')).status).toBe(401);
  expect((await fetch(`${fn.url}/sneaky`, { redirect: 'manual' })).status).toBe(404);
});

test('20 concurrent requests for one slug: exactly one wins', async () => {
  const slug = `race-${randomUUID().slice(0, 8)}`;
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => create({ url: `https://example.com/${i}`, slug })),
  );
  const statuses = results.map((r) => r.status).sort();
  expect(statuses.filter((s) => s === 201)).toHaveLength(1);
  expect(statuses.filter((s) => s === 409)).toHaveLength(19);
});

test('300 concurrent requests in one process: every response carries its own request ID', async () => {
  // One Web Function environment serves many requests at once. If request state lived in a
  // module-level variable, some responses here would carry another request's ID.
  const ids = Array.from({ length: 300 }, () => randomUUID());
  const responses = await Promise.all(
    ids.map((id, i) =>
      i % 2
        ? fetch(`${fn.url}/guide`, { redirect: 'manual', headers: { 'lambda-web-request-id': id } })
        : fetch(`${fn.url}/api/links`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'lambda-web-request-id': id },
            body: JSON.stringify({ url: `https://example.com/${id}` }),
          }),
    ),
  );
  const mismatched = responses.filter((r, i) => r.headers.get('x-request-id') !== ids[i]);
  expect(mismatched).toHaveLength(0);

  // The access log lines are tagged with the right request too.
  const tagged = fn.logs.filter((l) => l.includes('"msg":"request"')).map((l) => JSON.parse(l) as { requestId: string });
  for (const id of ids) expect(tagged.some((l) => l.requestId === id)).toBe(true);
});

test('SIGTERM with a request still in progress: exits inside Lambda\'s 1 second', async () => {
  const other = await startWebFunction(env());
  // A client that sent a valid key and half a body, then stalled. The handler is waiting on
  // the body, so server.close() alone would wait for it forever.
  const { port } = new URL(other.url);
  const socket = connect(Number(port), '127.0.0.1');
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.write(`POST /api/links HTTP/1.1\r\nHost: x\r\nx-api-key: ${KEY}\r\nContent-Length: 100\r\n\r\n{"url":`);
  await new Promise((r) => setTimeout(r, 100));

  const t = Date.now();
  expect(await other.stop()).toBe(0);
  expect(Date.now() - t).toBeLessThan(1000);
  socket.destroy();
});

test('a missing setting stops the process before it listens', async () => {
  const { LINKS_TABLE: _omit, ...rest } = env();
  await expect(startWebFunction(rest)).rejects.toThrow('Missing required environment variable LINKS_TABLE');
});
