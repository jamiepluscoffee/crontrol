"use client";

import { useEffect, useState } from "react";
import type { DashboardMember, DashboardRole } from "../db/access";
import type { PublishedSnapshot } from "../db/snapshots";

export function StatusDashboard({ initialSnapshot, viewer, viewerEmail, role }: { initialSnapshot: PublishedSnapshot | null; viewer: string; viewerEmail: string; role: DashboardRole }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [promptCopied, setPromptCopied] = useState(false);
  const [sharingOpen, setSharingOpen] = useState(false);
  const [members, setMembers] = useState<DashboardMember[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [sharingError, setSharingError] = useState("");
  const [sharingPending, setSharingPending] = useState(false);
  useEffect(() => {
    const refresh = () => fetch("/api/status", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ snapshot: PublishedSnapshot | null }> : null)
      .then((data) => { if (data) setSnapshot(data.snapshot); })
      .catch(() => undefined);
    const timer = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!snapshot) return <main className="status-shell empty-state">
    <header className="site-header"><Brand /><PrivateBadge /></header>
    <section className="waiting"><span className="waiting-dot" /><p className="kicker">WAITING FOR FIRST PUBLISH</p><h1>Your private cron view is ready.</h1><p>Run <code>ct publish</code> on the machine running Crontrol. Only the sanitized health snapshot will appear here.</p></section>
  </main>;

  const healthy = snapshot.jobs.filter((job) => job.state === "healthy").length;
  const attention = snapshot.jobs.length - healthy;
  const attentionJobs = snapshot.jobs.filter((job) => job.state !== "healthy");
  const copyHelpPrompt = async () => {
    const summary = attentionJobs.map((job) => `- ${job.name}: ${job.state}${job.incidentKind ? ` (${job.incidentKind})` : ""}; last run ${job.lastRunAt ?? "unknown"}`).join("\n");
    await navigator.clipboard.writeText(`Help me triage these Crontrol jobs:\n${summary}\n\nYou do not have my local logs or files. Tell me what evidence to inspect in the local Crontrol dashboard before recommending a fix.`);
    setPromptCopied(true);
    window.setTimeout(() => setPromptCopied(false), 1800);
  };
  return <main className="status-shell">
    <header className="site-header"><Brand /><div className="viewer"><PrivateBadge /><span>{viewer}</span><span className="role-badge">{role}</span>{role === "owner" && <button className="share-trigger" onClick={() => void toggleSharing()}>{sharingOpen ? "Close sharing" : "Share dashboard"}</button>}</div></header>
    {role === "owner" && sharingOpen && <section className="sharing-panel" aria-label="Dashboard access">
      <div><p className="kicker">VIEW ACCESS</p><h2>Share this dashboard</h2><p>Add the email someone uses for ChatGPT, then send them this dashboard URL. Viewers cannot publish, inspect logs, or approve fixes.</p></div>
      <form onSubmit={(event) => { event.preventDefault(); void inviteViewer(); }}><label htmlFor="viewer-email">ChatGPT email</label><div><input id="viewer-email" type="email" required value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="teammate@example.com" /><button disabled={sharingPending}>{sharingPending ? "Adding…" : "Add viewer"}</button></div></form>
      {sharingError && <p className="sharing-error" role="alert">{sharingError}</p>}
      <div className="member-list">{members.map((member) => <div key={member.email}><span><strong>{member.email === viewerEmail ? `${member.email} · you` : member.email}</strong><small>{member.role}{member.role === "viewer" && !member.lastSeenAt ? " · invited" : ""}</small></span>{member.role === "viewer" && <button disabled={sharingPending} onClick={() => void revokeViewer(member.email)}>Remove</button>}</div>)}</div>
    </section>}
    <section className="fleet-head">
      <div><p className="kicker">{snapshot.label.toUpperCase()}</p><h1>Corntrol your crons.</h1><p className="updated">Updated {relativeTime(snapshot.publishedAt)} · refreshes automatically</p></div>
      <dl className="totals"><div><dt>Jobs</dt><dd>{snapshot.jobs.length}</dd></div><div><dt>Healthy</dt><dd className="healthy-number">{healthy}</dd></div><div><dt>Needs attention</dt><dd className={attention ? "attention-number" : ""}>{attention}</dd></div></dl>
    </section>
    <section className="job-grid" aria-label="Published cron status">
      {snapshot.jobs.map((job) => <article className={`status-card ${job.state}`} key={job.name}>
        <div className="card-title"><span className="state-dot" /><h2>{job.name}</h2><span className="state-label">{job.state}</span></div>
        <p className="description">{job.description ?? "Monitored cron job"}</p>
        <div className="uptime-row"><span>30D</span><div>{job.uptimeDays.map((day) => <i key={day.date} className={day.state} title={`${day.date}: ${day.state === "empty" ? "no run" : day.state}`} />)}</div></div>
        <dl className="job-meta"><div><dt>Last run</dt><dd>{job.lastRunAt ? relativeTime(job.lastRunAt) : "never"}</dd></div><div><dt>Duration</dt><dd>{formatDuration(job.lastDurationMs)}</dd></div><div><dt>Runs</dt><dd>{job.runCount}</dd></div></dl>
        {job.incidentKind && <p className="attention-note">Needs attention · {job.incidentKind}</p>}
      </article>)}
    </section>
    <section className={`action-panel ${attention ? "has-attention" : "all-clear"}`} aria-label="Resolve issues">
      <div>
        <p className="kicker">{attention ? "TAKE ACTION" : "ALL CLEAR"}</p>
        <h2>{attention ? "Fix issues on your Crontrol machine." : "No action needed right now."}</h2>
        <p>{attention
          ? "Open the local dashboard on the machine running Crontrol, select the affected job, and review or approve the proposed fix. From another device, connect to that machine through your private tunnel first."
          : "This page will update after the next private publish."}</p>
      </div>
      {attention > 0 && <div className="action-buttons">
        <a className="primary-action" href="http://localhost:4100" target="_blank" rel="noreferrer">Open local Crontrol ↗</a>
        <button className="secondary-action" onClick={() => void copyHelpPrompt()}>{promptCopied ? "Prompt copied ✓" : "Copy prompt for GPT"}</button>
        <a className="chatgpt-link" href="https://chatgpt.com/" target="_blank" rel="noreferrer">Open ChatGPT ↗</a>
      </div>}
      <details>
        <summary>What does ChatGPT sign-in allow?</summary>
        <p>It protects who can view this private status page. It does not grant the site access to your local logs, files, or approval controls, so fixes remain deliberately local and human-approved.</p>
      </details>
    </section>
    <footer>Read-only private status · fixes and logs remain on your Crontrol machine</footer>
  </main>;

  async function toggleSharing() {
    const next = !sharingOpen;
    setSharingOpen(next);
    if (!next || members.length) return;
    await loadMembers();
  }

  async function loadMembers() {
    setSharingError("");
    const response = await fetch("/api/members", { cache: "no-store" });
    const body = await response.json() as { members?: DashboardMember[]; error?: string };
    if (!response.ok) { setSharingError(body.error ?? "Could not load access list"); return; }
    setMembers(body.members ?? []);
  }

  async function inviteViewer() {
    setSharingPending(true); setSharingError("");
    try {
      const response = await fetch("/api/members", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: inviteEmail }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not add viewer");
      setInviteEmail("");
      await loadMembers();
    } catch (error) { setSharingError(error instanceof Error ? error.message : "Could not add viewer"); }
    finally { setSharingPending(false); }
  }

  async function revokeViewer(email: string) {
    setSharingPending(true); setSharingError("");
    try {
      const response = await fetch(`/api/members?email=${encodeURIComponent(email)}`, { method: "DELETE" });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not remove viewer");
      await loadMembers();
    } catch (error) { setSharingError(error instanceof Error ? error.message : "Could not remove viewer"); }
    finally { setSharingPending(false); }
  }
}

function Brand() { return <div className="brand"><span className="brand-mark">C</span><div><strong>Crontrol</strong><span>PRIVATE STATUS</span></div></div>; }
function PrivateBadge() { return <span className="private-badge"><i />PRIVATE</span>; }
function relativeTime(value: string) { const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000)); if (seconds < 60) return `${seconds}s ago`; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`; return `${Math.floor(seconds / 86400)}d ago`; }
function formatDuration(value: number | null) { if (value === null) return "—"; return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`; }
