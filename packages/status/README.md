# Crontrol Private Status

Owner-only, read-only Sites dashboard for sanitized Crontrol fleet snapshots.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm ci
npm run dev
npm test
```

`CRONTROL_PUBLISH_TOKEN` protects `POST /api/publish`. `CRONTROL_OWNER_EMAIL` identifies the dashboard owner. Production browser requests pass through Sign in with ChatGPT and then a server-side D1 membership check. Owners can add or remove read-only viewers by ChatGPT email from the dashboard. The publisher sends an explicit allowlist and never includes commands, paths, logs, proposals, evidence, action output, or credentials.

The D1 migration in `drizzle/` stores recent snapshots. `.openai/hosting.json` identifies the existing Sites project and must not contain runtime secrets.
