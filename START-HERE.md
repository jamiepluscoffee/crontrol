# Set up Crontrol with Codex

You do not need to understand cron, terminals, databases, or website hosting to set up Crontrol. Open this repository in the Codex app and send the prompt below.

## Copy this into Codex

> Set up Crontrol for me from start to finish. Read `START-HERE.md` and `AGENTS.md` in full, then follow the Crontrol onboarding runbook. Do the work instead of only explaining the steps. Keep secrets out of chat and source control. Discover my existing scheduled jobs read-only, recommend which ones are appropriate to monitor, and wait for my approval before changing any schedule. Set up and verify the local dashboard, then provision my private read-only Sites dashboard if Sites is available. Continue until the acceptance checklist is complete or tell me the single specific action I must take to unblock you.

Codex will install and build Crontrol, help you add an OpenAI API key securely, find your existing scheduled jobs, and show you its recommendations. Nothing in your schedules is changed until you approve the exact proposal.

After local monitoring works, Codex can provision the private status dashboard, configure sanitized publishing, and help you invite viewers. ChatGPT sign-in controls dashboard identity; it does not replace the separately billed OpenAI API key used for incident diagnosis.

## What Codex will ask you for

Only these decisions require you:

1. Create an OpenAI API key and save it locally when Codex asks. Never paste it into the conversation.
2. Choose which discovered jobs Crontrol may monitor.
3. Approve the exact schedule changes, whether Crontrol should keep running in the background, and whether its bounded per-boot Auto fix mode should be enabled.
4. Confirm the ChatGPT email that should own the private dashboard and approve its access level.

At the end, Codex will open the working dashboards and leave you a short summary containing their URLs, the jobs being monitored, how status stays current, and how to stop or undo what it installed.
