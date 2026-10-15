#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { LinksStack } from '../lib/links-stack';

const app = new cdk.App();

// Optional: cdk deploy -c alertEmail=you@example.com
const alertEmail: unknown = app.node.tryGetContext('alertEmail');
if (alertEmail !== undefined && (typeof alertEmail !== 'string' || !alertEmail.includes('@'))) {
  throw new Error(`alertEmail must be an email address, got ${JSON.stringify(alertEmail)}`);
}

new LinksStack(app, 'WebFunctionLinks', {
  alertEmail,
  // Web Functions launched in us-east-1, us-east-2, us-west-2, ap-northeast-1 and eu-west-1.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

// Fail synth on any AWS Solutions finding that isn't acknowledged with a reason.
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
