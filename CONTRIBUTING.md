# Contributing

Open an issue for a bug or proposal, or submit a pull request with a focused change.
Contributions are licensed under [Apache-2.0](LICENSE).

## Development

Use Node 22.19+ from the repository directory:

```bash
npm ci
TB_TEST_SHARED_ENV=true npm test
npm pack --dry-run
```

Tests use synthetic models, isolated Pi settings and loopback collectors. They do
not require model-provider, Slack or RawTree credentials.

Add behavior tests before runtime changes. Keep export failures nonfatal, default
content capture compatible, and sensitive values out of diagnostics and artifacts.

## Privacy

Do not submit credentials, real prompts, model reasoning, tool responses or exported
traces. Use synthetic reproductions; redaction cannot guarantee arbitrary data is safe.

Report security-sensitive issues privately to a repository maintainer. Do not put
credentials or exploitable security details in a public issue.
