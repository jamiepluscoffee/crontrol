---
name: crontrol-spec
type: spec
domain: hackathon
status: active
created: 2026-07-20
target: OpenAI Build Week, Developer Tools track, deadline 2026-07-21 17:00 PDT
---

# Crontrol: a supervisor for headless AI agents

This spec is self-contained and written to be handed to Codex as the build brief. Commit it as `SPEC.md` in the fresh repo. Build order matters: milestones are sequenced so the project is submittable at the end of every milestone, and the 3-minute demo drives every scope decision.

## 1. Product

**Crontrol** (CLI: `ct`, package `crontrol`) is a local-first supervisor for headless AI agents and scheduled jobs. Anyone running unattended automation (cron-launched LLM agents, nightly pipelines, scraping jobs, CI-adjacent scripts) has the same three problems: they can't see whether jobs ran, they find out about failures days later, and diagnosing a 3am failure means archaeology through scattered logs. Crontrol gives them a run ledger, a liveness watchdog, and an AI sentinel that reads the evidence when something breaks and proposes a concrete fix a human approves with one click.

The AI-native part is the point: the sentinel is powered by GPT-5.6 and is the product's core, not a garnish. Failure diagnosis with a proposed, reviewable fix is what separates this from a cron monitor.

**Track:** Developer Tools. **Hackathon constraints that shape this spec:** majority of core functionality built in Codex with GPT-5.6 (session ID submitted), public repo with README setup instructions, demo video under 3 minutes.

## 2. The 3-minute demo (build to this)

1. Clone, `pnpm install && pnpm build`, then `pnpm exec ct demo`: dashboard opens with six realistic jobs and weeks of seeded history. (15s)
2. Wrap a real cron in one line: `ct run --name nightly-brief --every 24h -- ./brief.sh`. Run it; watch the run appear live with duration, exit code, log tail. (30s)
3. Press the demo's chaos button (or `ct chaos`): the contents of a script used by a demo cron are corrupted and its next run fails. Card flips red. (15s)
4. The sentinel wakes automatically: GPT-5.6 reads the job definition, failing log, and last-good diff, and posts an incident: root cause in plain language, evidence lines cited, a proposed fix as a patch, risk level, confidence. (45s, the heart of the video)
5. One click on Approve: the fix applies, the job reruns green, the incident closes with a timeline of what happened. (30s)
6. Close on the fleet view: uptime bars, cost column for LLM jobs, "your agents, supervised." (15s)

Everything not needed for these six beats is a stretch goal.

## 3. Architecture

Monorepo, TypeScript throughout, pnpm workspaces:

```
crontrol/
  packages/cli/        # `ct` command (commander.js), the reporter + supervisor client
  packages/server/     # Fastify API + static dashboard hosting + watchdog + sentinel
  packages/web/        # React + Vite dashboard (Tailwind), built into server/public
  packages/shared/     # types, ledger schema, zod schemas shared by all three
```

- **Storage:** SQLite via better-sqlite3, single file at `~/.crontrol/crontrol.db`. No external services. WAL mode so CLI writes and server reads never block each other.
- **Processes:** one long-lived local server (`ct up`, default port 4100) owns the watchdog and sentinel. The CLI talks to it over HTTP when it is up and writes straight to SQLite when it is not, so `ct run` works standalone from any cron with zero daemon dependency.
- **LLM:** OpenAI SDK, model `gpt-5.6`, Structured Outputs (JSON schema) for every sentinel call. API key from `OPENAI_API_KEY` (a gitignored project `.env` is supported for the clone-based quickstart); a missing key degrades gracefully. The key is used only by the server's OpenAI client and is stripped from every job child process.

## 4. Data model (SQLite)

```sql
jobs      (id, name UNIQUE, command, cwd, description, schedule_hint,
           expected_interval_s, grace_s, created_at, archived)
runs      (id, job_id, started_at, ended_at, exit_code, duration_ms,
           log_tail TEXT,          -- last 200 lines, secrets redacted
           tokens_in, tokens_out, cost_usd,   -- nullable; parsed if reported
           source)                 -- 'wrap' | 'api' | 'demo'
incidents (id, job_id, run_id, opened_at, closed_at,
           kind,                   -- 'failure' | 'stale' | 'flapping'
           status)                 -- 'open' | 'proposed' | 'applied' | 'dismissed'
proposals (id, incident_id, created_at, model, root_cause, evidence_json,
           fix_kind,               -- 'patch' | 'command' | 'config'
           fix_body, risk, confidence, applied_at, apply_result)
```

## 5. Components

### 5.1 CLI (`ct`)

- `ct run --name <n> [--every <dur>] -- <cmd...>`: the reporter. Spawns the command, captures exit code, duration, and a rolling 200-line log tail, writes the run, upserts the job (with `expected_interval_s` when `--every` is given). Redacts obvious secrets from the tail before storage (regexes for `sk-`, `key=`, `token=`, `Bearer`, `password`). Optional `--desc "<what this job is supposed to do>"` stores a one-line human statement of intent on the job (it feeds the sentinel), and `--grace <dur>` overrides the default grace window. This one command is the entire adoption story: prefix any crontab line with it.
- `ct up` / `ct down`: start/stop the server + dashboard (prints the URL).
- `ct status`: terminal fleet summary (name, last run, state, next expected).
- `ct doctor`: confirms that `OPENAI_API_KEY` is present and that the configured account can access `gpt-5.6-sol`, without printing the secret.
- `ct demo`: seeds six jobs with 2-3 weeks of plausible history (a nightly briefing agent, a scraper, a db backup, a model-eval batch, a link checker, a report mailer), including one flapping job and realistic log tails. Idempotent; `--reset` wipes and reseeds.
- `ct chaos`: corrupts the contents of a seeded script so the next run fails with a realistic, diagnosable syntax error and GPT-5.6 can propose a durable patch to the actual file cron invokes. Exists so the demo video and any judge poking the repo can trigger the full incident loop on cue.

### 5.2 Watchdog (in server)

Every 30s, for jobs that declared an interval: mark a job **late** (amber, dashboard-only) as soon as a run is overdue, and **stale** once it is overdue by more than the job's grace window (`grace_s`, default `0.5 × expected_interval_s`; the grace-time model is borrowed from healthchecks.io and kills false alarms for variable-duration jobs). Mark **failure** on any nonzero exit; mark **flapping** when 3 of the last 5 runs alternated pass/fail. Failure, stale, and flapping transitions open an incident (one open incident per job at a time) and trigger the sentinel; late never opens an incident.

### 5.3 Sentinel (GPT-5.6, the core)

On incident open, build a context bundle: job row including its human-written `description` of intent (what the job is supposed to do sharpens root-cause reasoning more than any other single input), the failing run's log tail, the last successful run's log tail, the diff between the two commands/configs if any, and the last 10 runs' exit codes and durations. Call `gpt-5.6` with Structured Outputs against this schema:

```ts
{
  root_cause: string,          // one paragraph, plain language, names the mechanism
  evidence: {line: string, why_it_matters: string}[],  // cites actual log lines
  fix: { kind: 'patch' | 'command' | 'config',
         body: string,         // unified diff, exact shell command, or config change
         explanation: string },
  risk: 'low' | 'medium' | 'high',
  confidence: number           // 0-1
}
```

System prompt requirements: reason only from the supplied evidence; if the evidence is insufficient, say so and propose the single most informative next diagnostic command instead of guessing; never propose destructive commands (rm, drop, force-push); prefer the smallest fix that makes the job pass again. A second GPT-5.6 call reviews the first proposal as a skeptic ("would this fix work given the evidence, and what could it break") and its verdict is stored and shown on the incident card as "verified by second pass" or the objection found. Two calls per incident, cheap, and it demos beautifully.

**Approval gate, non-negotiable:** proposals are never auto-applied. The dashboard shows the full fix body. One-click Approve is available only for durable patch and config fixes; it applies the change, reruns the job once, and records the outcome. Command fixes are labeled "manual apply" and offered as copy-paste instructions because Crontrol does not yet own the user's scheduler definition. Remote-ping jobs are diagnosis-only and cannot apply local fixes. Dismiss closes the incident with a stored reason.

### 5.4 Dashboard (React + Vite + Tailwind)

Design language: dense, dark, calm; a NASA-flight-console feel without kitsch. Grid of job cards: status dot (green / amber late / red failed-or-stale / grey never-ran), sparkline of recent durations, last-run time, uptime bar over 30 days. Clicking a card opens the job page: run table, log-tail viewer, an editable description field (stored on the job, fed to the sentinel), and the incident timeline where sentinel proposals render as structured cards (root cause, evidence lines in monospace with the cited text highlighted, fix as a syntax-highlighted diff, risk badge, confidence bar, Approve / Dismiss). A fleet header shows totals: jobs green, incidents open, LLM spend today across jobs that report cost. Mobile-responsive: the approve flow must work from a phone. Live updates via SSE from the server (no websocket library needed).

### 5.5 API (Fastify)

`GET /api/jobs`, `GET /api/jobs/:id` (runs + incidents), `GET /api/session` (per-boot mutation token), `POST /api/runs` (reporter ingest), `POST /api/ping/:name` (same-host or tunneled ingest for jobs that cannot be wrapped; optional `?state=start|success|fail`), `POST /api/incidents/:id/approve`, `POST /api/incidents/:id/dismiss`, `GET /api/events` (SSE), `POST /api/chaos` (demo only). Mutating dashboard requests require an expected loopback Host/Origin and the per-boot token. Keep the server bound to loopback and Zod-validate boundaries.

## 6. Milestones (submittable after each)

- **M1, the spine (~4h):** shared schema + CLI `ct run` writing runs to SQLite + `ct demo` seed + minimal read-only dashboard showing cards from real data. Submittable as "run ledger for agents."
- **M2, supervision (~3h):** server + watchdog + incidents + SSE live updates + `ct chaos` + the `/api/ping/:name` remote-ingest route. Cards go red on their own.
- **M3, the sentinel (~5h):** GPT-5.6 diagnosis with structured output, incident cards with evidence + fix, the skeptic second pass, approve/dismiss executing fixes with the rerun loop. This is the product; protect these hours.
- **M4, release hardening then polish (~half day):** (1) make patch/config fixes one-click and command fixes manual-only; change chaos to demonstrate a durable patch, (2) strip secret variables from child processes, (3) protect mutations with loopback Host/Origin checks plus a per-boot dashboard token and refuse local apply for remote jobs, (4) add `ct doctor`, then (5) complete the flight-console design pass, uptime bars, mobile approve, README, and a verified clone-to-dashboard quickstart.
- **M4.1, private visibility:** add `ct publish` and a private, owner-only Sites dashboard. Publishing is explicit or scheduled by the user and sends only an allowlisted fleet snapshot (job identity/description, health, last-run metadata, incident kind, and 30-day uptime). It must never publish commands, working directories, logs, evidence, proposals, action results, or secrets. The hosted surface is read-only; all diagnosis and mutation remain loopback-only.
- **Roadmap after submission:** managed jobs (`ct execute`), start/stop plus launchd/systemd persistence, rerun timeouts and patch rollback, proposal audit retention, webhook notifications, authenticated remote ping, cron-expression awareness/import, and single-package npm distribution.

Cut from the bottom. M1-M3 plus a decent README beats M1-M5 half-finished.

## 7. Non-goals (resist these)

No multi-user administration, no hosted mutation, no remote agents, no plugin system, no historical analytics beyond the 30-day bar, no auto-apply mode, no support for Windows task scheduler (document mac/linux cron + any shell loop). M4.1's optional cloud component is a private, read-only snapshot rather than a synchronized control plane.

## 8. Submission checklist (from the hackathon rules)

- Public repo, README with setup (target: clone to dashboard in under 2 minutes: `pnpm install && pnpm build && pnpm exec ct demo && pnpm exec ct up`).
- Demo video under 3 minutes on YouTube following section 2, explicitly showing Codex building it and GPT-5.6 in the sentinel calls (show the model name in code and in the incident card footer: "diagnosed by gpt-5.6").
- Codex session ID: keep all build sessions in Codex; the majority of core functionality must come from those sessions.
- Category: Developer Tools. Project description: compress section 1 into 3 sentences; lead with "your unattended agents, supervised, with failures diagnosed and fixed under human approval."

## 9. Acceptance criteria

1. A crontab line prefixed with `ct run --name x --every 24h --` records runs with no daemon running.
2. `ct demo && ct up` shows six populated cards within 60 seconds of clone on a clean machine with Node 20+.
3. `ct chaos` produces, without human input: red card, open incident, GPT-5.6 proposal citing at least one real log line, within 30 seconds.
4. Approving the chaos patch changes the actual script invoked by the job, makes the rerun pass, and closes the incident, all visible live in the dashboard. Command proposals are clearly manual-only.
5. Sentinel with no API key set: dashboard still fully functional, incident card explains what is missing.
6. No secret-looking string from a job's output ever appears in the DB or any LLM request (test with a seeded job that echoes a fake `sk-` key).
7. `ct publish` sends only the documented allowlist to an owner-only Sites dashboard; the hosted dashboard cannot trigger chaos, approve/dismiss incidents, view logs, or mutate the local supervisor.
