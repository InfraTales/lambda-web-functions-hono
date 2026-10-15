/**
 * A stand-in for the Secrets Manager endpoint, just enough for GetSecretValue.
 * The real bundle reaches it through AWS_ENDPOINT_URL_SECRETS_MANAGER, so no test-only
 * code path exists in the app.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function startFakeSecretsManager(secretString: string): Promise<{ url: string; calls: () => number; close: () => Promise<void> }> {
  let calls = 0;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      calls++;
      const target = req.headers['x-amz-target'];
      res.setHeader('content-type', 'application/x-amz-json-1.1');
      if (target !== 'secretsmanager.GetSecretValue') {
        res.statusCode = 400;
        res.end(JSON.stringify({ __type: 'InvalidRequestException', message: `unexpected ${String(target)}` }));
        return;
      }
      const { SecretId } = JSON.parse(body) as { SecretId: string };
      res.end(JSON.stringify({ ARN: SecretId, Name: 'api-key', SecretString: secretString, VersionId: 'v1' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls: () => calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
