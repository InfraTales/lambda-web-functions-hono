# Runbook

This page covers the one alarm, and a few checks for problems that don't trip it.

## ServerErrors

More than 5% of CloudFront requests got a 5xx for 3 of the last 5 minutes.

1. Open the log group `/aws/lambda/web/<stack>-links`. Look for `"level":"error"` lines. Each has a `requestId`.
2. Match the `requestId` to the `x-request-id` response header if a user reported a failure.
3. Common causes:
   - **504 with `lambda-web-error-type: Runtime.RequestTimeout`:** a request took longer than 10 seconds. Check DynamoDB for throttling.
   - **429:** traffic is above the endpoint's `rateLimit` of 100 per second. Raise it in the stack if the traffic is real.
   - **500 with "API key secret is empty":** someone cleared the secret. Put a value back.
   - **403 on every request:** the resource policy or the OAC changed. Redeploy the stack, which rewrites both.

## The app won't start

If every request fails right after a deploy, the server may not be listening within 10 seconds, or a setting is missing. Look for `Missing required environment variable` in the logs. The stack sets `LINKS_TABLE` and `API_KEY_SECRET_ARN`. If one is missing, check CloudTrail for a manual edit to the revision.

## A new deploy fails on the revision

A revision reads its code from the versioned code bucket. If the bucket policy no longer lets `lambda.amazonaws.com` read it, the revision moves to `Failed`, and that state is permanent. Redeploy the stack to restore the policy, which creates a new revision.

## Checking one link

```bash
aws dynamodb get-item --table-name <TableName> --key '{"slug": {"S": "launch"}}'
```

The API has no way to edit a link. To change one, update the item in DynamoDB, then invalidate `/<slug>` in CloudFront. Otherwise the old redirect stays cached for up to a day.
