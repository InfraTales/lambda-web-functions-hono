# Cost

These are monthly costs in us-east-1, before the AWS Free Tier. We took every price from the AWS Price List API on 2026-10-15, and the article workspace's `sources/aws-facts.md` links to each source.

## Web Function pricing

| Part | Price | When you pay |
|---|---|---|
| Requests | $0.30 per million | Every request that reaches the endpoint |
| Active CPU | $0.0000276944 per vCPU-second | Only while your code is using the CPU |
| Memory | $0.0000036667 per GB-second | For as long as each environment exists, including idle time |

Every environment has 2 GB. One that stays up for a 30-day month costs 2 × 2,592,000 × $0.0000036667 = **$19.01**. AWS says environments scale to zero when there's no traffic, but it doesn't say how long an idle one stays. So we treat memory as a range. It's near $0 if Lambda shuts environments down soon after traffic stops, and up to $19.01 for each one that never stops.

`maxEnvironments: 4` puts a ceiling on it. Memory can't cost more than $76.03 a month.

## What we measured

The bundle used 0.23 ms of CPU per redirect and 0.30 ms per create. We measured 5,000 requests each on an Apple M4 against DynamoDB Local with `scripts/measure-cpu.ts`. Graviton will differ, so the model uses 1 ms per request. Check your real numbers in CloudWatch after a deploy.

## This app at two sizes

We assume CloudFront serves 80% of redirects from its cache. Each edge location keeps a link for a day, so popular links hit far more often than that. Measure yours with the `x-cache` header.

| Item | 1M redirects, 10k creates | 30M redirects, 300k creates |
|---|---|---|
| Requests reaching the Web Function | 210,000 | 6.3 million |
| CloudFront requests and data out | $1.05 | $31.53 |
| Web Function requests and CPU | $0.07 | $2.06 |
| DynamoDB | $0.02 | $0.56 |
| Secrets Manager | $0.44 | $0.44 |
| CloudWatch alarm and logs | $0.12 | $0.83 |
| **Subtotal** | **$1.71** | **$35.43** |
| Web Function memory | $0 to $19.01 per environment | $0 to $19.01 per environment |

CloudFront's always-free tier covers 10 million requests and 1 TB a month. That takes the CloudFront line for the smaller month to zero.

## When a classic Lambda function is cheaper

A classic Lambda function (now called an Event Function) bills memory only while a request runs. With 512 MB on arm64 and 20 ms per redirect, it costs $0.333 per million requests. The Web Function costs $0.328 per million for requests and CPU. That's the same, so for this app the difference is the memory floor. At low, steady traffic, a classic function is cheaper by up to $19.01 a month per environment Lambda keeps up.

The picture flips when requests wait on something slow. Take 10 million requests a month that each wait 1 second on an outside API. A 512 MB classic function bills the whole wait: $68.67. A Web Function bills the CPU, not the wait, and one environment holds 64 of those waits at once. That's $3.28 for requests and CPU, plus $19.01 to $38.02 for one or two environments.

The rule of thumb: classic functions charge for the time each request takes. Web Functions charge for the time each environment exists. Pick the one that matches how your traffic spends its time.

## Things that change the bill

- **Cache hit rate.** Every redirect CloudFront serves never reaches Lambda or DynamoDB.
- **maxConcurrencyPerEnvironment.** Lower it and Lambda needs more environments for the same traffic, and each one bills 2 GB.
- **Data transfer.** Web Functions bill data transfer at standard AWS rates. Redirects are a few hundred bytes, so we left it out.
