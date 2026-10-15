# Security notes

This page explains each security choice in the stack, and the ones we left out.

## Only CloudFront can reach the app

A Web Function endpoint has a public HTTPS address. We set its auth type to `IamAuth`, so Lambda rejects any request without a valid AWS signature. The other choice is `ApplicationManaged`. It lets every request through and leaves auth to your code.

CloudFront signs each request it forwards, using origin access control (OAC) with origin type `lambda` and signing behaviour `always-amz-auth`. The Web Function's resource policy allows `lambda:InvokeWebFunctionEndpoint` for `cloudfront.amazonaws.com`, but only when `aws:SourceArn` is this distribution. Another account's CloudFront distribution can't use your endpoint.

A Web Function has one resource policy, and writing it replaces the old one. The stack owns the whole policy through `AWS::Lambda::ResourcePolicy`. Don't also edit it by hand, or the next deploy will undo your change.

The smoke test checks this after a deploy: a direct call to the endpoint must get 403.

## Two headers to get right

**Host.** If CloudFront forwards the viewer's `Host` header, the endpoint sees the CloudFront domain and answers 404. Both cache behaviours use the managed `AllViewerExceptHostHeader` origin request policy.

**Authorization.** With `always-amz-auth`, CloudFront puts its own signature in a separate header and passes the viewer's `Authorization` header through unchanged. We still send the API key as `x-api-key`. It stays clear of anything that handles `Authorization` in its own way, and the origin request policy forwards it to the app.

You don't need to send a body hash (`x-amz-content-sha256`) when you POST through CloudFront. That's different from Lambda function URL origins, which require it.

## Writes need an API key

`POST /api/links` checks the `x-api-key` header against a key in AWS Secrets Manager. The comparison hashes both values and uses `crypto.timingSafeEqual`, so response time doesn't show how close a guess was. A wrong or missing key gets 401 before the body is read.

The key is read on the first request and cached for 5 minutes per environment. Concurrent requests share one read. A failed read isn't cached.

To rotate the key, put a new value in the secret and give it to your clients. Environments pick it up within 5 minutes, and the old key stops working at the same time. If you need an overlap, change `keyMatches` to accept a current and a previous key.

## Links can't be used for tricks

- Targets must be `http` or `https`. `javascript:`, `data:` and `file:` URLs get a 400.
- Targets can't contain a user name or password, such as `https://bank.example@evil.example`.
- Slugs are 3 to 32 letters, digits, `-` or `_`. The app keeps `api`, `healthz` and a few other paths for itself.
- Nobody can take over a slug. The DynamoDB write has the condition `attribute_not_exists(slug)`, and a test races 20 requests for one slug against DynamoDB Local.

## Least privilege

| Who | Can do | Can't do |
|---|---|---|
| Web Function role | `GetItem` and `PutItem` on the links table, read the API key, write its own log group | Scan, update or delete links, read any other secret |
| Lambda service (code bucket) | Read objects, only for revisions of this function | Write, list, or read for any other function |
| CloudFront | Call the `prod` endpoint of this function | Call anything else |

## Limits that cap abuse and cost

- The endpoint accepts at most 100 requests per second (`rateLimit`). Over that, Lambda answers 429.
- At most 4 environments run at once (`maxEnvironments`). That caps the memory charge at $76.03 a month.
- Request bodies over 4 KiB get a 413.
- Each request times out after 10 seconds.

## What we chose not to add

- **AWS WAF.** It adds a monthly charge per web ACL and per rule. The rate limit, the environment cap and the API key cover this app. Add WAF if people abuse your public link service. A rate-based rule per IP is a good first rule.
- **A custom domain.** With the default `*.cloudfront.net` certificate, CloudFront uses the TLSv1 security policy and you can't raise it. Add your domain and an AWS Certificate Manager certificate to get `TLSv1.2_2021`, which `cdk.json` already asks for.
- **CloudFront access logs.** The app writes one JSON line, with its request ID, for every request that reaches it. Cached redirects never reach it. Turn on CloudFront standard logging if you need those.
- **Automatic key rotation.** Clients hold the key, so rotation needs them anyway.

## cdk-nag

`cdk synth` runs the cdk-nag AWS Solutions pack and fails on any finding without a written reason. The reasons live next to the code in `infra/lib/links-stack.ts`. We acknowledge the CDK `BucketDeployment` helper's findings on that construct only. A wildcard added to our own role would still fail the build.
