# Crontrol

Your unattended agents, supervised, with failures diagnosed and fixed under human approval.

Crontrol is a local-first run ledger and watchdog for cron jobs, headless AI agents, scrapers, backups, and scheduled pipelines. Prefix a job with `ct run` to record its outcome in SQLite; keep `ct up` running to detect failures, stale schedules, and flapping jobs. When something breaks, GPT-5.6 reads a redacted evidence bundle and proposes a reviewable fix, never an automatic one.

Monitoring tells you your cron died. Crontrol reads the body, names the cause, and hands you the fix.

## 60-second quickstart

Requirements: macOS or Linux, Node.js 20+, Git, and Corepack.

```bash
git clone https://github.com/jamiepluscoffee/crontrol.git
cd crontrol

corepack pnpm install
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY.

corepack pnpm build
corepack pnpm exec ct doctor
corepack pnpm exec ct demo --reset
corepack pnpm exec ct up
```

Open [http://localhost:4100](http://localhost:4100). In another terminal, trigger the durable patch demo:

```bash
corepack pnpm exec ct chaos
```

The nightly briefing script is corrupted, its run fails, and GPT-5.6 proposes a patch to the actual script. Review the evidence and skeptic pass, then approve the patch. Crontrol applies it, reruns the same job, and closes the incident only if the rerun passes.

This is currently a clone-based release. It is not published as a standalone npm package yet.

## OpenAI setup

1. Create a project-scoped key on the [OpenAI API keys page](https://platform.openai.com/api-keys).
2. Add it to the gitignored `.env` file as `OPENAI_API_KEY=...`.
3. Run `corepack pnpm exec ct doctor`.

`ct doctor` confirms that the key exists and that the account can access `gpt-5.6-sol`; it never prints the key. OpenAI API billing is separate from a ChatGPT subscription, so the API project must have billing or credits configured.

The key stays in the local server process and is removed from environments used for approved reruns and demo jobs. It is never sent to the dashboard. Do not commit `.env`.

Without a key, the ledger, watchdog, dashboard, and incident detection continue to work. Incident cards explain that AI diagnosis is unavailable.

## Wrap a real cron job

Use the absolute path to the clone's installed `ct` binary so cron does not depend on an interactive shell's `PATH`:

```cron
0 6 * * * cd /absolute/path/to/your/job && /absolute/path/to/crontrol/node_modules/.bin/ct run --name morning-brief --every 24h --desc "Build the morning briefing" -- ./brief.sh
```

`ct run` records directly to `~/.crontrol/crontrol.db`, even when the dashboard server is not running. When `ct up` is available, the run also appears live through SSE.

Useful options:

```bash
ct run --name NAME --every 24h --grace 2h --desc "Job intent" -- COMMAND
ct demo [--reset]
ct up [--port 4100]
ct chaos
ct doctor
ct publish
```

## Private status publishing (M4.1)

Crontrol includes an optional owner-only Sites dashboard for checking cron health away from the machine running `ct up`. The local ledger remains the source of truth. `ct publish` sends only an allowlisted snapshot: job name and description, state, last-run time and duration, run count, incident kind, and the 30-day uptime strip. Commands, working directories, logs, evidence, proposals, and API keys are never published.

The checked-in site lives in `packages/status`. Deploy it privately with Codex Sites, then add the three values supplied during setup to the gitignored `.env`:

```bash
CRONTROL_STATUS_URL=https://your-private-site.example
CRONTROL_PUBLISH_TOKEN=generated-publisher-secret
CRONTROL_SITES_TOKEN=generated-sites-bypass-token
```

Restart `ct up`. The status box now includes **Publish private status** and a link to the private dashboard. You can also publish from cron without keeping the local dashboard open:

To avoid depending on exported variables after setup, save them once to `~/.crontrol/publish.json` (created with owner-only file permissions):

```bash
corepack pnpm exec ct publish --configure
```

```cron
*/5 * * * * cd /absolute/path/to/crontrol && corepack pnpm exec ct publish
```

The hosted dashboard is read-only and protected by Sign in with ChatGPT plus Crontrol's owner/viewer membership check. The Sites bypass token is used only for the machine-to-site publish request; keep both publishing tokens out of source control. This private status feature does not replace `OPENAI_API_KEY`: ChatGPT sign-in establishes viewer identity, while sentinel diagnosis uses the separately billed OpenAI API.

### Share view access

M4.2 adds product-owned viewer permissions. The dashboard owner can select **Share dashboard**, add the email a teammate uses for ChatGPT, and send them the dashboard URL. After ChatGPT sign-in, every page and status API request checks that normalized email against the D1 membership list. Unknown accounts see no fleet data; viewers remain read-only and cannot publish, inspect logs, trigger chaos, or approve fixes. Owners can revoke access from the same panel, and membership changes are audit logged.

`CRONTROL_OWNER_EMAIL` is configured in the Sites runtime during provisioning. It is not inferred from the first visitor, which prevents account-claim races.

## Fix semantics

- Patch fixes modify the real file in the job's working directory and can be approved with one click.
- Config fixes write the displayed replacement content to the displayed relative path and can be approved with one click.
- Command fixes are labeled **manual apply** and are copyable. Crontrol does not yet own the user's crontab or service definition, so pretending to apply a command change would not be durable.
- Jobs reported through `remote:*` pings are diagnosis-only; fixes must be applied on the machine that owns them.

Every applied durable fix is followed by one recorded rerun. A passing rerun closes the incident; a failure returns it to diagnosis with the new evidence.

## Security and privacy

- The server binds only to `127.0.0.1`.
- Mutating requests require a random per-boot token and matching loopback Host/Origin headers.
- Obvious secret patterns are redacted before log tails reach SQLite or an LLM request.
- Credential-like environment variables are stripped from server-owned child processes.
- Fixes are shown in full and require human approval. There is no auto-apply mode.

For diagnosis, redacted excerpts of the failing log, the last successful log, recent run metadata, the job description, and bounded contents of command-referenced local files are sent to the OpenAI API. Do not use Crontrol on workloads whose logs or source files cannot be shared with that API.

The SQLite ledger lives at `~/.crontrol/crontrol.db`. Set `CRONTROL_DB` to override the location.

## Same-host ping ingestion

The ping API is loopback-only in this release. It is suitable for same-host jobs, or a tunnel that terminates with a loopback Host header. Obtain the per-boot token first:

```bash
TOKEN=$(curl -s http://127.0.0.1:4100/api/session | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).token')
curl -X POST -H "x-crontrol-token: $TOKEN" --data-binary @job.log \
  "http://127.0.0.1:4100/api/ping/nightly-import?state=success"
```

Use `state=start`, then `state=success` or `state=fail`, to track duration while the server remains running.

## Current operating model

`ct up` is a foreground process. Keep that terminal open; for longer demos or personal use, run it inside tmux or a locally managed launchd/systemd unit. Run recording does not require the server, but watchdog and GPT diagnosis do.

## Architecture

- `packages/cli`: Commander CLI and cron wrapper
- `packages/server`: Fastify API, watchdog, sentinel, approval gate, static hosting
- `packages/web`: React/Vite dashboard
- `packages/shared`: SQLite schema, Zod contracts, supervision logic
- `packages/status`: independent Sites app for the optional private read-only dashboard

The database uses SQLite WAL mode so cron writers and the dashboard can operate concurrently.

## Development

```bash
corepack pnpm build
corepack pnpm test
npm --prefix packages/status test
npm --prefix packages/status run build
```

The M3/M4 tests cover structured two-pass proposals, durable patch approval and green rerun, manual command semantics, dismissal, no-key behavior, redaction, child-environment isolation, remote-job refusal, mutation security, failed-fix feedback, and flapping resolution. M4.1 adds an allowlist test proving that publication excludes commands, paths, logs, evidence, proposals, and secrets.

## Built with Codex and GPT-5.6

This project was built from scratch during OpenAI Build Week, in a single Codex session, with GPT-5.6 as both the build partner and the product's core.

**How the collaboration worked.** The product was specced in full before the first prompt (`SPEC.md` in this repo), with the 3-minute demo as the scope contract and five milestones sequenced so the project was submittable at the end of each. Codex built each milestone from the spec; bugs were reported back to Codex in plain language and it fixed its own code.

**Two difficult moments materially improved the product.** First, an early command-level "fix" passed its immediate rerun but was not durable, because cron still invoked the original command; human review caught the integrity gap, and Codex reworked approval semantics so one-click fixes are reserved for durable file and configuration patches. Second, a repaired flapping job was immediately reopened because the watchdog's five-run window still contained pre-fix failures; together we traced this to the supervision model and changed incident resolution to reset the flapping baseline without deleting historical evidence.

**Where the human made the calls:** product scope, the milestone order, the never-auto-apply security posture, the demo design, and the mid-build decision that mattered most: re-scoping M4 from polish to release-hardening after that durability review.

**Where GPT-5.6 is the product, not just the builder.** The sentinel's two-pass diagnose-then-verify loop runs on `gpt-5.6-sol` with Structured Outputs; the model's name sits in the incident card footer because the diagnosis quality is the feature. In the final live chaos test, GPT-5.6 identified a missing POSIX-shell `fi` from the actual end-of-file error, used the earlier successful "Fetched 38 sources" output to localize the failure, and proposed only the necessary one-line patch at 99% confidence. Its skeptic pass verified the reasoning; approval applied the patch, reran the real job successfully, and closed the incident. The complete chaos-to-healthy loop took 49 seconds.

## What's next

- Managed jobs through `ct execute`, making approved command changes durable
- `start`/`stop` commands and launchd/systemd persistence
- Rerun timeouts and automatic rollback for failed patches/config changes
- Full proposal and action audit retention across re-diagnosis
- Webhook notifications
- Authenticated remote ping ingestion
- Cron-expression import and schedule awareness
- Single-package npm distribution
- Guided one-button Sites provisioning for installations running outside Codex
- Optional invitation email delivery (M4.2 currently requires the owner to share the URL)
- A managed Crontrol service for users who prefer account-based billing over their own OpenAI API project

## License

MIT
