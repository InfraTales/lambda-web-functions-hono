import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { BUNDLE_DIR, LinksStack } from '../../infra/lib/links-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const stack = new LinksStack(new cdk.App(), 'Test', { env, alertEmail: 'ops@example.com' });
const template = Template.fromStack(stack);
const only = (type: string) => {
  const all = Object.values<any>(template.findResources(type));
  expect(all).toHaveLength(1);
  return all[0];
};

test('the endpoint only accepts signed requests, with a rate limit and an environment cap', () => {
  template.hasResourceProperties('AWS::Lambda::WebFunctionEndpoint', {
    AuthType: 'IamAuth',
    EndpointType: 'HomeRegion',
    ScalingConfig: { MaxEnvironments: 4 },
    ThrottleConfig: { RateLimit: 100 },
    RevisionWeights: [{ RevisionId: { 'Fn::GetAtt': [Match.stringLikeRegexp('^Revision'), 'RevisionId'] }, Weight: 100 }],
  });
});

test('the revision runs Node.js 24 with a short timeout and the default 64 requests per environment', () => {
  template.hasResourceProperties('AWS::Lambda::WebFunctionRevision', {
    BuildConfig: { RuntimeConfig: { Runtime: 'nodejs24.x' } },
    ServiceConfig: Match.objectLike({
      TimeoutSeconds: 10,
      MaxConcurrencyPerEnvironment: 64,
      EnvironmentVariables: Match.objectLike({ LINKS_TABLE: Match.anyValue(), API_KEY_SECRET_ARN: Match.anyValue() }),
    }),
  });
});

test('only this CloudFront distribution may call the endpoint', () => {
  const policy = only('AWS::Lambda::ResourcePolicy').Properties;
  expect(policy.ResourceArn).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^WebFunction/), 'FunctionArn'] });
  const [statement, ...rest] = policy.PolicyDocument.Statement;
  expect(rest).toHaveLength(0);
  expect(statement).toMatchObject({
    Effect: 'Allow',
    Principal: { Service: 'cloudfront.amazonaws.com' },
    Action: 'lambda:InvokeWebFunctionEndpoint',
    Resource: { 'Fn::GetAtt': [expect.stringMatching(/^Endpoint/), 'EndpointArn'] },
  });
  const sourceArn = JSON.stringify(statement.Condition.ArnLike['aws:SourceArn']);
  expect(sourceArn).toMatch(/distribution\//);
  expect(sourceArn).toMatch(/Distribution[0-9A-F]+/);
});

test('CloudFront signs origin requests with a lambda-type origin access control', () => {
  template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
    OriginAccessControlConfig: { OriginAccessControlOriginType: 'lambda', SigningBehavior: 'always-amz-auth', SigningProtocol: 'sigv4' },
  });
  const dist = only('AWS::CloudFront::Distribution').Properties.DistributionConfig;
  expect(dist.Origins).toHaveLength(1);
  expect(dist.Origins[0].OriginAccessControlId).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^OriginAccessControl/), 'Id'] });
  expect(dist.Origins[0].DomainName).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^Endpoint/), 'DomainName'] });
  expect(dist.Origins[0].CustomOriginConfig).toMatchObject({ OriginProtocolPolicy: 'https-only', OriginSSLProtocols: ['TLSv1.2'] });
});

test('the Host header is never forwarded, and /api/* is never cached', () => {
  const dist = only('AWS::CloudFront::Distribution').Properties.DistributionConfig;
  const allViewerExceptHost = 'b689b0a8-53d0-40ab-baf2-68738e2966ac'; // AWS managed policy ID
  const cachingDisabled = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
  expect(dist.DefaultCacheBehavior.OriginRequestPolicyId).toBe(allViewerExceptHost);
  expect(dist.DefaultCacheBehavior.AllowedMethods).toEqual(['GET', 'HEAD']);
  const api = dist.CacheBehaviors.find((b: any) => b.PathPattern === '/api/*');
  expect(api.OriginRequestPolicyId).toBe(allViewerExceptHost);
  expect(api.CachePolicyId).toBe(cachingDisabled);
  expect(api.ViewerProtocolPolicy).toBe('https-only');
});

test('redirects are cached only as long as the app says', () => {
  template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
    CachePolicyConfig: Match.objectLike({ MinTTL: 0, DefaultTTL: 0, MaxTTL: 86400 }),
  });
});

test('the code bucket is versioned, private, and readable by Lambda only for this function\'s revisions', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    VersioningConfiguration: { Status: 'Enabled' },
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
  });
  const statements = only('AWS::S3::BucketPolicy').Properties.PolicyDocument.Statement as any[];
  const lambdaRead = statements.find((s) => s.Sid === 'AllowLambdaWebFunctionCodeAccess');
  expect(lambdaRead).toMatchObject({ Principal: { Service: 'lambda.amazonaws.com' }, Action: ['s3:GetObject', 's3:GetObjectVersion'] });
  expect(JSON.stringify(lambdaRead.Condition.ArnLike['aws:SourceArn'])).toContain(
    ':lambda:us-east-1:123456789012:web-function/Test-links/revision/*',
  );
});

test('the execution role can read and create links, read the key, and write its own logs. Nothing else.', () => {
  const role = Object.entries<any>(template.findResources('AWS::IAM::Policy')).find(([id]) => id.startsWith('ExecutionRole'))![1];
  const actions = role.Properties.PolicyDocument.Statement.flatMap((s: any) => [].concat(s.Action)).sort();
  expect(actions).toEqual([
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'logs:CreateLogStream',
    'logs:PutLogEvents',
    'secretsmanager:DescribeSecret',
    'secretsmanager:GetSecretValue',
  ]);
});

test('the links table survives a stack delete', () => {
  template.hasResource('AWS::DynamoDB::GlobalTable', {
    Properties: Match.objectLike({ KeySchema: [{ AttributeName: 'slug', KeyType: 'HASH' }] }),
    DeletionPolicy: 'Retain',
  });
});

test('a 5xx alarm notifies the alert topic', () => {
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: '5xxErrorRate',
    Namespace: 'AWS/CloudFront',
    AlarmActions: [Match.anyValue()],
  });
});

test('the revision waits for its code, role and bucket policy', () => {
  const revision = Object.values<any>(template.findResources('AWS::Lambda::WebFunctionRevision'))[0];
  const deps: string[] = revision.DependsOn;
  for (const prefix of ['WebFunction', 'CodeUpload', 'ExecutionRole', 'CodeBucketPolicy', 'Logs']) {
    expect(deps.some((d) => d.startsWith(prefix))).toBe(true);
  }
});

test('cdk-nag AWS Solutions finds nothing unacknowledged', () => {
  const app = new cdk.App({ outdir: fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-nag-')) });
  new LinksStack(app, 'Nag', { env });
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  const assembly = app.synth();
  const report = JSON.parse(fs.readFileSync(path.join(assembly.directory, 'validation-report.json'), 'utf8'));
  for (const plugin of report.pluginReports) expect(plugin.violations).toEqual([]);
});

test('synth stops with a clear message when the bundle is missing', () => {
  const backup = `${BUNDLE_DIR}.bak-${process.pid}`;
  fs.renameSync(BUNDLE_DIR, backup);
  try {
    expect(() => new LinksStack(new cdk.App(), 'NoBundle', { env })).toThrow('Run "npm run bundle" first');
  } finally {
    fs.renameSync(backup, BUNDLE_DIR);
  }
});
