/**
 * Entry point. On Lambda Web Functions this is index.js at the root of the package.
 * Locally: `npm run dev`. Same code, same server, no adapter.
 */
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createApp } from './app';
import { cachedApiKey } from './auth';
import { listenAddress, requireEnv } from './config';
import { log } from './context';
import { DynamoLinkStore } from './links';
import { randomSlug } from './slug';

// Lambda gives the process 1 second after SIGTERM. Leave a margin.
const SHUTDOWN_GRACE_MS = 800;

// Settings and clients are created once per environment and shared by every request.
// That's safe: they hold no per-request state.
const tableName = requireEnv('LINKS_TABLE');
const apiKeySecretArn = requireEnv('API_KEY_SECRET_ARN');
// Tests point the SDK at DynamoDB Local with the standard AWS_ENDPOINT_URL_DYNAMODB variable.
const dynamo = new DynamoDBClient({});

const app = createApp({
  store: new DynamoLinkStore(DynamoDBDocumentClient.from(dynamo), tableName),
  getApiKey: cachedApiKey(new SecretsManagerClient({}), apiKeySecretArn),
  newSlug: () => randomSlug(),
  now: () => new Date(),
});

// Lambda waits up to 10 seconds for the server to listen. Nothing slow runs before this:
// the API key is read on first use, not at startup.
const { hostname, port } = listenAddress();
const server = serve({ fetch: app.fetch, hostname, port }, (info) => {
  log('info', 'listening', { address: info.address, port: info.port });
}) as Server;

process.on('SIGTERM', () => {
  log('info', 'SIGTERM: closing server');
  // close() stops new connections and drops idle keep-alive ones (Node 19+). A request
  // still in progress would keep the process alive, so exit anyway before Lambda kills it.
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
});
