# Crontrol agent instructions

## Guided onboarding

When a user asks to set up, install, try, or onboard Crontrol, read `START-HERE.md` and execute this runbook. Assume the user is nontechnical. Perform safe work directly and explain only decisions they need to make.

### Safety invariants

- Never ask the user to paste an API key, publishing token, bypass token, or other secret into chat.
- Never print, log, commit, or publish secret values. Store local secrets only in gitignored files with owner-only permissions.
- Treat schedule discovery as read-only. Never install, rewrite, reload, enable, disable, or run a discovered job without showing the proposed action and obtaining explicit approval.
- Do not recommend monitoring vendor updaters, operating-system maintenance, or unfamiliar privileged jobs. Explain uncertainty instead.
- Back up every schedule definition before an approved edit and tell the user how to restore it.
- Do not run an existing job merely to test monitoring unless the user approves; scheduled jobs can have real side effects.
- Keep the hosted dashboard read-only. Publish only the allowlisted snapshot implemented by `buildPublishedSnapshot`.
- Do not declare setup complete until the relevant checks below pass.

### Phase 1: local preflight

1. Confirm the repository is a clean or understood checkout. Preserve unrelated user changes.
2. Run `corepack pnpm onboard`. This installs dependencies, creates a gitignored `.env` template when needed, builds the workspace, checks the OpenAI configuration when present, and runs read-only schedule discovery.
3. If the preflight pauses for `OPENAI_API_KEY`, direct the user to `https://platform.openai.com/api-keys`. Ask them to place the key after `OPENAI_API_KEY=` in the local `.env` file themselves, then rerun the preflight. Do not request the value in chat. Explain that API billing is separate from ChatGPT.
4. If `gpt-5.6-sol` access fails, report the exact redacted error and help the user correct project access or billing before continuing.

### Phase 2: choose real jobs

1. Run `corepack pnpm exec ct discover --json` and assess the returned jobs. The output is already secret-redacted.
2. Present a short human list: recognizable purpose, schedule, whether it is already monitored, and a recommendation of monitor / leave alone / uncertain.
3. Ask the user which recommended jobs to monitor. If they only want to try the product, offer the six-job demo instead and seed with `ct demo`; never use `--reset` when a ledger may contain user data.
4. For each selected job, inspect its original definition locally and prepare an exact reversible change that wraps only the real executable with the absolute clone path to `node_modules/.bin/ct run`. Preserve its working directory, arguments, environment, redirects, schedule, and shell semantics. Choose a stable unique name and add an accurate description. Add `--every` only when the interval is known.
5. Show the proposed changes and backup locations. Apply them only after explicit approval. Validate the scheduler syntax before reloading it. Ask separately before executing the job as a test.

### Phase 3: local dashboard

1. Start `ct up` in a retained process and open the exact local URL it prints.
2. Verify the dashboard loads. If a selected job was safely tested, verify its real run appears. Otherwise clearly state that its first card will appear after its next scheduled run.
3. Offer to keep supervision running after Codex closes. If accepted, show and obtain approval for a user-scoped launchd service on macOS or systemd user service on Linux. It must run the repository's built CLI from this checkout, use the repository as its working directory so the gitignored `.env` loads, restart on failure, and write logs under `~/.crontrol/`. Validate and start it, then verify `GET /api/jobs`. Do not install a system-wide or root service.
4. Explain that Auto fix is off by default and resets to off whenever `ct up` restarts. Offer it only as an explicit choice: it applies one low-risk, at-least-95%-confidence patch/config attempt after a verified skeptic pass. Command fixes, remote jobs, stale/flapping incidents, and repeat attempts remain manual.

### Phase 4: private status dashboard

1. Ask whether the user wants remote view-only status. Skip this phase if they decline.
2. Confirm the Sites capability is available in their Codex installation. If it is unavailable or blocked by workspace policy, finish local setup and report this one optional limitation clearly.
3. Ask for the ChatGPT account email that will be the owner. Normalize it but do not infer ownership from the first visitor.
4. Use the Sites capability path for the existing app in `packages/status`. Create a new site for this user; do not reuse a project ID from another checkout or maintainer. The app requires D1, Sign in with ChatGPT, `CRONTROL_OWNER_EMAIL`, and `CRONTROL_PUBLISH_TOKEN` as a hosted secret.
5. Generate a strong random publishing token without displaying it. Configure it in the Sites runtime and in the local gitignored Crontrol publishing configuration. If the Sites dispatcher requires a shared/public outer access policy so invited ChatGPT users can reach sign-in, explain that the application still denies all nonmembers server-side and obtain approval for that access level.
6. Build, test, and deploy the site. Configure the returned site URL and any machine-to-site bypass credential locally, then run `corepack pnpm exec ct publish --configure` for the first sanitized publish.
7. Verify: the owner can sign in; an anonymous request and a signed-in nonmember cannot read fleet data; the hosted surface has no logs, commands, fixes, chaos, or local mutation controls.
8. Offer automatic status refresh. If accepted, show and obtain approval for a user-scoped schedule that runs `ct publish` every five minutes. Verify one scheduled or equivalent manual publish before completion.

### Phase 5: handoff

Return one concise summary containing:

- local dashboard URL and whether supervision persists after Codex closes;
- private dashboard URL and current publishing frequency, when configured;
- monitored jobs and when their first/next result is expected;
- owner and viewer-management location without exposing credentials;
- how to stop the supervisor, remove publishing, and restore schedule backups;
- any optional phase the user declined or any exact remaining blocker.

### Acceptance checklist

- `corepack pnpm build` succeeds.
- `corepack pnpm test` succeeds.
- `ct doctor` confirms the API key and model access without printing the key.
- `ct discover` completes and no schedule changed before approval.
- The local dashboard responds and shows either approved real jobs or the opted-in demo.
- Every approved scheduler edit has a backup and passes platform validation.
- If Sites was selected: the owner can read the published snapshot, unauthorized users cannot, and the remote dashboard remains view-only.
- The user receives working URLs and rollback instructions.
