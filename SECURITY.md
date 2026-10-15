# Security policy

## Reporting a problem

Please don't report security problems in public GitHub issues. Use GitHub's private vulnerability reporting on this repository (Security tab, then "Report a vulnerability").

It helps to include the file and line or the commit, the steps to reproduce, and what an attacker could do with it.

## How this stack protects itself

The short version is below. [docs/security.md](docs/security.md) has the details and the reasons.

- The Web Function endpoint only accepts requests signed by this CloudFront distribution.
- Creating a link needs an API key from AWS Secrets Manager, checked in constant time.
- Link targets must be plain http or https URLs, and nobody can take over an existing slug.
- The function's role can read and create links and nothing else.
