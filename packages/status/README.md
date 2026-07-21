# Crontrol Private Status

Owner-only, read-only Sites dashboard for sanitized Crontrol fleet snapshots.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm ci
npm run dev
npm test
```

`CRONTROL_PUBLISH_TOKEN` protects `POST /api/publish`. Production requests also pass through the Sites Sign in with ChatGPT gate. The publisher sends an explicit allowlist and never includes commands, paths, logs, proposals, evidence, action output, or credentials.

The D1 migration in `drizzle/` stores recent snapshots. `.openai/hosting.json` identifies the existing Sites project and must not contain runtime secrets.
