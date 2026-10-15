# Contributing

Thanks for helping. This repo shows how to run an unchanged Node.js web app on Lambda Web Functions, and every change has to keep the tests honest about how the runtime behaves.

## Setup

You need Node.js 24 and npm. Docker is only needed for the integration tests.

```bash
npm ci
npm run check        # type check, lint, bundle, unit + infra tests, synth with cdk-nag
npm run dev          # the same server on http://127.0.0.1:3000
```

To run the integration tests:

```bash
docker run -d --rm -p 8000:8000 amazon/dynamodb-local:3.3.2
AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8000 npm run test:int
```

## Layout

| Path | What's there |
|---|---|
| `app/src/app.ts` | The Hono routes. Knows nothing about Lambda. |
| `app/src/server.ts` | Starts the server on `AWS_LAMBDA_HTTP_ENDPOINT` and handles `SIGTERM` |
| `app/src/context.ts` | Per-request context with `AsyncLocalStorage` |
| `infra/lib/links-stack.ts` | The CDK stack |
| `test/unit`, `test/infra` | Tests that run with `npm test` |
| `test/server` | The real bundle against DynamoDB Local |
| `scripts/` | Bundling, CPU measurement and the smoke test |

## What a change needs

- **A test that fails without it.** For a bug, write the failing test first.
- **No module-level request state.** Up to 64 requests share one process. Use `runWithContext` and `currentRequestId`.
- **No slow work before `listen`.** Lambda allows 10 seconds. Load secrets on first use.
- **A written reason for any cdk-nag acknowledgement**, scoped to the construct it's about.
- **Docs updated** when behaviour changes.

## Pull requests

Branch from `main`, keep each pull request to one change, and explain why in the description. CI must pass before merge.

Found a security problem? Don't open a public issue. [SECURITY.md](SECURITY.md) says where to send it.

---

Created by Rahul Ladumor / InfraTales
