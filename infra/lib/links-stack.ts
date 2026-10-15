import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';

export const BUNDLE_DIR = path.join(__dirname, '..', '..', 'build', 'web');

export interface LinksStackProps extends cdk.StackProps {
  /** Email for alarms. Optional. */
  alertEmail?: string;
  /**
   * Most environments the endpoint may run at once. Each one bills 2 GB of memory for as
   * long as it exists, so this is also the ceiling on the memory part of the bill.
   */
  maxEnvironments?: number;
  /** Requests per second the endpoint accepts. Allowed: 100-1000 in steps of 100, then 2000-10000 in steps of 1000. */
  rateLimit?: number;
}

export class LinksStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LinksStackProps = {}) {
    super(scope, id, props);

    if (!fs.existsSync(path.join(BUNDLE_DIR, 'index.js'))) {
      throw new Error(`${BUNDLE_DIR}/index.js is missing. Run "npm run bundle" first.`);
    }

    const functionName = `${this.stackName}-links`;
    const revisionArnPattern = `arn:${this.partition}:lambda:${this.region}:${this.account}:web-function/${functionName}/revision/*`;

    // ---------- data ----------
    const table = new dynamodb.TableV2(this, 'Links', {
      partitionKey: { name: 'slug', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // The key that clients send as x-api-key to create links.
    const apiKey = new secretsmanager.Secret(this, 'ApiKey', {
      description: 'API key for POST /api/links (sent as the x-api-key header)',
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });

    // ---------- code ----------
    // Web Functions read code from S3 with their own service principal. The bucket must be
    // versioned, and its policy has to let lambda.amazonaws.com read objects, but only for
    // revisions of this function.
    const codeBucket = new s3.Bucket(this, 'CodeBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const codeReadPolicy = codeBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowLambdaWebFunctionCodeAccess',
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [codeBucket.arnForObjects('*')],
        conditions: { ArnLike: { 'aws:SourceArn': revisionArnPattern } },
      }),
    );

    // Copies the zipped bundle into the code bucket as one object named after its hash.
    // A code change means a new key, so a new revision.
    const code = new s3deploy.BucketDeployment(this, 'CodeUpload', {
      sources: [s3deploy.Source.asset(BUNDLE_DIR)],
      destinationBucket: codeBucket,
      extract: false,
      prune: false,
    });

    // ---------- the Web Function ----------
    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/aws/lambda/web/${functionName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const role = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Runs the ${functionName} Web Function`,
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [logGroup.logGroupArn],
      }),
    );
    // Read one link, create one link. No scans, no updates, no deletes.
    table.grant(role, 'dynamodb:GetItem', 'dynamodb:PutItem');
    apiKey.grantRead(role);

    const webFunction = new lambda.CfnWebFunction(this, 'WebFunction', { functionName });

    const revision = new lambda.CfnWebFunctionRevision(this, 'Revision', {
      functionName,
      description: 'Hono links app',
      buildConfig: {
        codeConfig: { s3Object: { bucket: codeBucket.bucketName, key: cdk.Fn.select(0, code.objectKeys) } },
        runtimeConfig: { runtime: 'nodejs24.x' },
      },
      serviceConfig: {
        executionRoleArn: role.roleArn,
        // Redirects and creates take milliseconds. A short timeout stops a stuck call
        // from holding one of the environment's concurrent slots.
        timeoutSeconds: 10,
        maxConcurrencyPerEnvironment: 64,
        environmentVariables: {
          LINKS_TABLE: table.tableName,
          API_KEY_SECRET_ARN: apiKey.secretArn,
          NODE_OPTIONS: '--enable-source-maps',
        },
        telemetryConfig: { loggingConfig: { logGroup: logGroup.logGroupName } },
      },
    });
    revision.addResourceDependency(webFunction);
    revision.node.addDependency(code, role, logGroup);
    if (codeReadPolicy.policyDependable) revision.node.addDependency(codeReadPolicy.policyDependable);

    const endpoint = new lambda.CfnWebFunctionEndpoint(this, 'Endpoint', {
      functionName,
      endpointName: 'prod',
      endpointType: 'HomeRegion',
      // Only signed requests get in. CloudFront signs them for us (origin access control).
      authType: 'IamAuth',
      revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
      scalingConfig: { maxEnvironments: props.maxEnvironments ?? 4 },
      throttleConfig: { rateLimit: props.rateLimit ?? 100 },
    });
    endpoint.addResourceDependency(webFunction);

    // ---------- CloudFront in front ----------
    const oac = new cloudfront.CfnOriginAccessControl(this, 'OriginAccessControl', {
      originAccessControlConfig: {
        name: `${this.stackName}-web-fn`.slice(0, 64),
        description: 'CloudFront signs every request to the Web Function endpoint',
        originAccessControlOriginType: 'lambda',
        // The only behaviour Web Function origins accept. CloudFront adds its own signature
        // and leaves the viewer's headers alone.
        signingBehavior: 'always-amz-auth',
        signingProtocol: 'sigv4',
      },
    });

    const origin = new origins.HttpOrigin(endpoint.attrDomainName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
    });

    // Honour the app's Cache-Control: redirects for a day at the edge, misses for a minute.
    const redirectCache = new cloudfront.CachePolicy(this, 'RedirectCache', {
      comment: 'Uses the Cache-Control header the app sends',
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.days(1),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // The endpoint answers 404 when Host is the CloudFront domain, so never forward Host.
    const forwardAllButHost = cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER;

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Links app on Lambda Web Functions',
      defaultBehavior: {
        origin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: redirectCache,
        originRequestPolicy: forwardAllButHost,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      additionalBehaviors: {
        '/api/*': {
          origin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: forwardAllButHost,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        },
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });
    (distribution.node.defaultChild as cloudfront.CfnDistribution).addPropertyOverride(
      'DistributionConfig.Origins.0.OriginAccessControlId',
      oac.attrId,
    );

    // The Web Function's resource policy: only this distribution may call the prod endpoint.
    // A Web Function has one policy; this resource owns all of it.
    new lambda.CfnResourcePolicy(this, 'AllowCloudFront', {
      resourceArn: webFunction.attrFunctionArn,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowCloudFrontOACAccess',
            Effect: 'Allow',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Action: 'lambda:InvokeWebFunctionEndpoint',
            Resource: endpoint.attrEndpointArn,
            Condition: { ArnLike: { 'aws:SourceArn': distribution.distributionArn } },
          },
        ],
      },
    });

    // ---------- alarms ----------
    const alerts = new sns.Topic(this, 'Alerts', { enforceSSL: true });
    if (props.alertEmail) {
      new sns.Subscription(this, 'AlertEmail', { topic: alerts, protocol: sns.SubscriptionProtocol.EMAIL, endpoint: props.alertEmail });
    }
    new cloudwatch.Alarm(this, 'ServerErrors', {
      alarmDescription: 'More than 5% of requests failed with 5xx for 3 of the last 5 minutes. Check the Web Function logs.',
      metric: distribution.metric5xxErrorRate({ period: cdk.Duration.minutes(1), statistic: 'Average' }),
      threshold: 5,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cwActions.SnsAction(alerts));

    // ---------- outputs ----------
    new cdk.CfnOutput(this, 'Url', { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'EndpointDomain', { value: endpoint.attrDomainName });
    new cdk.CfnOutput(this, 'ApiKeySecretArn', { value: apiKey.secretArn });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });

    this.acknowledgeFindings(distribution, codeBucket, apiKey);
  }

  /** Every cdk-nag finding we accept, scoped as tightly as possible, each with its reason. */
  private acknowledgeFindings(distribution: cloudfront.Distribution, codeBucket: s3.Bucket, apiKey: secretsmanager.Secret): void {
    const ack = (scope: Construct, id: string, reason: string) => cdk.Validations.of(scope).acknowledge({ id, reason });

    // CDK's BucketDeployment helper: a Lambda function that runs only during `cdk deploy`
    // to copy the code zip from the CDK assets bucket into the code bucket. CDK writes its
    // runtime and policy; the wildcards are object-level actions on those two buckets only.
    const helper = this.node.children.find((c) => c.node.id.startsWith('Custom::CDKBucketDeployment'));
    if (!helper) throw new Error('BucketDeployment helper not found; check the cdk-nag acknowledgements');
    const helperReason = 'CDK BucketDeployment helper, run only at deploy time; CDK sets its runtime and its policy, which covers only the CDK assets bucket and the code bucket.';
    ack(helper, 'AwsSolutions::AwsSolutions-L1', helperReason);
    ack(helper, 'AwsSolutions::AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]', helperReason);
    // cdk-nag prints the assets bucket with the account and region as written in the template:
    // a placeholder for an environment-agnostic stack, the number when the account is known.
    const account = cdk.Token.isUnresolved(this.account) ? '<AWS::AccountId>' : this.account;
    const region = cdk.Token.isUnresolved(this.region) ? '<AWS::Region>' : this.region;
    for (const finding of ['Action::s3:GetBucket*', 'Action::s3:GetObject*', 'Action::s3:List*', 'Action::s3:Abort*', 'Action::s3:DeleteObject*',
      ...['<AWS::Partition>', 'aws'].map((partition) => `Resource::arn:${partition}:s3:::cdk-hnb659fds-assets-${account}-${region}/*`),
      `Resource::<${this.getLogicalId(codeBucket.node.defaultChild as s3.CfnBucket)}.Arn>/*`]) {
      ack(helper, `AwsSolutions::AwsSolutions-IAM5[${finding}]`, helperReason);
    }

    ack(codeBucket, 'AwsSolutions::AwsSolutions-S1',
      'Holds only build zips. The only readers are the deploy helper and the Lambda service principal (scoped to this function\'s revisions). Turn on CloudTrail S3 data events if you need a read log.');

    ack(apiKey, 'AwsSolutions::AwsSolutions-SMG4',
      'Clients hold this key, so rotation has to be coordinated with them. docs/security.md has the manual rotation steps.');

    ack(distribution, 'AwsSolutions::AwsSolutions-CFR4',
      'The default *.cloudfront.net certificate can\'t set a minimum TLS version. Add a custom domain and ACM certificate to get TLSv1.2_2021 (enabled in cdk.json).');
    ack(distribution, 'AwsSolutions::AwsSolutions-CFR3',
      'Every request that reaches the origin is logged as JSON with its request ID in the Web Function log group. Edge cache hits are not; turn on CloudFront standard logging if you need them.');
    ack(distribution, 'AwsSolutions::AwsSolutions-CFR2',
      'Not on by default to keep the base cost low. The endpoint has its own rate limit and environment cap, and writes need an API key. docs/security.md covers when to add AWS WAF.');
    ack(distribution, 'AwsSolutions::AwsSolutions-CFR1', 'A public link service with no country restrictions.');

    // CDK's bundled CloudFormation schema predates Lambda Web Functions (October 2026).
    // The types are documented: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lambda-webfunction.html
    for (const id of ['WebFunction', 'Revision', 'Endpoint']) {
      ack(this.node.findChild(id), 'CloudFormation-Validate::F3006', 'AWS::Lambda::WebFunction* types launched in October 2026, after the schema bundled with this CDK version.');
    }
  }
}
