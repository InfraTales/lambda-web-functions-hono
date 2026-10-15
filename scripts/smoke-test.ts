/**
 * Run after `npm run deploy`. Acts as a client against the deployed stack and checks
 * the things that only a real deploy can prove.
 *
 *   AWS_REGION=us-east-1 npm run smoke
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const STACK = process.env.STACK_NAME ?? 'WebFunctionLinks';

async function outputs(): Promise<Record<string, string>> {
  const res = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: STACK }));
  return Object.fromEntries((res.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
}

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`FAIL: ${message}`);
  console.log(`ok - ${message}`);
}

async function main(): Promise<void> {
  const out = await outputs();
  const key = (await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: out.ApiKeySecretArn }))).SecretString!;
  const base = out.Url!;
  const slug = `smoke-${Date.now().toString(36)}`;
  const post = (body: unknown, apiKey?: string) =>
    fetch(`${base}/api/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
      body: JSON.stringify(body),
    });

  // 1. The endpoint itself refuses anything CloudFront didn't sign.
  const direct = await fetch(`https://${out.EndpointDomain}/healthz`);
  check(direct.status === 403, `direct call to the endpoint is refused (got ${direct.status})`);

  // 2. Through CloudFront: health, auth, create, conflict.
  check((await fetch(`${base}/healthz`)).status === 200, 'GET /healthz through CloudFront is 200');
  check((await post({ url: 'https://example.com' })).status === 401, 'POST without the API key is 401');
  const created = await post({ url: 'https://aws.amazon.com/lambda/', slug }, key);
  check(created.status === 201, `POST /api/links creates "${slug}"`);
  check((await post({ url: 'https://example.com', slug }, key)).status === 409, 'the same slug again is 409');

  // 3. Redirect, then the same redirect from the CloudFront cache.
  const first = await fetch(`${base}/${slug}`, { redirect: 'manual' });
  check(first.status === 301 && first.headers.get('location') === 'https://aws.amazon.com/lambda/', 'GET /<slug> redirects with 301');
  const second = await fetch(`${base}/${slug}`, { redirect: 'manual' });
  check((second.headers.get('x-cache') ?? '').startsWith('Hit'), `the second redirect is a CloudFront cache hit (x-cache: ${second.headers.get('x-cache')})`);

  console.log('\nsmoke test passed');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
