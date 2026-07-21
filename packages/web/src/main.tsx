import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { IncidentDetail, JobCard, JobDetail, ProposalRow } from '@crontrol/shared';
import './styles.css';

let mutationToken = '';

async function mutate(url: string, init: RequestInit = {}) {
  if (!mutationToken) {
    const session = await fetch('/api/session');
    if (!session.ok) throw new Error(`Session request failed (${session.status})`);
    mutationToken = ((await session.json()) as { token: string }).token;
  }
  const headers = new Headers(init.headers);
  headers.set('x-crontrol-token', mutationToken);
  return fetch(url, { ...init, method: init.method ?? 'POST', headers });
}

function App() {
  const [jobs, setJobs] = useState<JobCard[]>([]);
  const [error, setError] = useState('');
  const [chaosPending, setChaosPending] = useState(false);
  const [autoFixPending, setAutoFixPending] = useState(false);
  const [autoFix, setAutoFix] = useState({ enabled: false, applying: false, policy: '' });
  const [publishPending, setPublishPending] = useState(false);
  const [publishMessage, setPublishMessage] = useState('');
  const [remoteStatus, setRemoteStatus] = useState<{ configured: boolean; siteUrl: string | null; published: boolean }>({ configured: false, siteUrl: null, published: false });
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);

  const loadJobs = useCallback(() => fetch('/api/jobs').then((response) => {
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return response.json() as Promise<{ jobs: JobCard[] }>;
  }).then((data) => { setJobs(data.jobs); setError(''); }), []);

  const loadDetail = useCallback((id: number) => fetch(`/api/jobs/${id}`).then((response) => {
    if (!response.ok) throw new Error(`Job request failed (${response.status})`);
    return response.json() as Promise<JobDetail>;
  }).then((job) => setDetail(job)), []);
  const loadAutoFix = useCallback(() => fetch('/api/auto-fix').then((response) => {
    if (!response.ok) throw new Error(`Auto fix status failed (${response.status})`);
    return response.json() as Promise<typeof autoFix>;
  }).then(setAutoFix), []);

  useEffect(() => {
    void loadJobs().catch((reason: Error) => setError(reason.message));
    void loadAutoFix().catch((reason: Error) => setError(reason.message));
    void fetch('/api/remote-status').then((response) => response.json() as Promise<typeof remoteStatus>).then(setRemoteStatus).catch(() => undefined);
    const events = new EventSource('/api/events');
    const refresh = () => {
      void loadJobs().catch((reason: Error) => setError(reason.message));
      void loadAutoFix().catch((reason: Error) => setError(reason.message));
      if (selectedJobId !== null) void loadDetail(selectedJobId).catch((reason: Error) => setError(reason.message));
    };
    for (const event of ['ready', 'run', 'job', 'jobs', 'incident', 'proposal', 'incident-closed', 'auto-fix']) events.addEventListener(event, refresh);
    events.onerror = () => setError((current) => current || 'Live updates disconnected; retrying…');
    return () => events.close();
  }, [loadAutoFix, loadDetail, loadJobs, selectedJobId]);

  const healthy = jobs.filter((job) => job.state === 'healthy').length;
  const openIncidents = jobs.filter((job) => job.open_incident_id !== null).length;
  const publishSucceeded = publishMessage.startsWith('Published');
  const triggerChaos = async () => {
    setChaosPending(true);
    try {
      const response = await mutate('/api/chaos');
      if (!response.ok) throw new Error(`Chaos failed (${response.status})`);
      await loadJobs();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Chaos failed');
    } finally { setChaosPending(false); }
  };
  const toggleAutoFix = async () => {
    setAutoFixPending(true);
    try {
      const response = await mutate('/api/auto-fix', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !autoFix.enabled })
      });
      const result = await response.json() as { enabled?: boolean; applying?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error ?? `Auto fix update failed (${response.status})`);
      setAutoFix((current) => ({ ...current, enabled: Boolean(result.enabled), applying: Boolean(result.applying) }));
      setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Auto fix update failed'); }
    finally { setAutoFixPending(false); }
  };
  const publishRemote = async () => {
    setPublishPending(true); setPublishMessage('');
    try {
      const response = await mutate('/api/remote-status/publish');
      const result = await response.json() as { error?: string; jobs?: number };
      if (!response.ok) throw new Error(result.error ?? `Publish failed (${response.status})`);
      setPublishMessage(`Published ${result.jobs ?? jobs.length} jobs ✓`);
      setRemoteStatus((current) => ({ ...current, published: true }));
    } catch (reason) { setPublishMessage(reason instanceof Error ? reason.message : 'Publish failed'); }
    finally { setPublishPending(false); }
  };
  const openJob = (id: number) => {
    setSelectedJobId(id);
    setDetail(null);
    void loadDetail(id).catch((reason: Error) => setError(reason.message));
  };
  const refreshSelected = async () => {
    await loadJobs();
    if (selectedJobId !== null) await loadDetail(selectedJobId);
  };

  return <main>
    <header>
      <div><p className="eyebrow">CORNTROL YOUR CRONS</p><h1>Crontrol</h1></div>
      <div className="header-panels">
        <section className="status-box" aria-label="Fleet status">
          <p className="status-label">STATUS</p>
          <dl className="status-values">
            <div><dt>Jobs</dt><dd>{jobs.length}</dd></div>
            <div><dt>Healthy</dt><dd className="healthy-value">{healthy}</dd></div>
            <div><dt>Needs attention</dt><dd className={openIncidents ? 'attention-value' : ''}>{openIncidents}</dd></div>
          </dl>
          <div className="status-actions">
            <button className="chaos-button" disabled={chaosPending} onClick={() => void triggerChaos()}>{chaosPending ? 'Breaking…' : 'Trigger chaos'}</button>
            <button
              className={`auto-fix-button ${autoFix.enabled ? 'is-on' : ''}`}
              disabled={autoFixPending}
              aria-pressed={autoFix.enabled}
              title={autoFix.policy}
              onClick={() => void toggleAutoFix()}
            >{autoFix.applying ? 'Auto fixing…' : `Auto fix ${autoFix.enabled ? 'ON' : 'OFF'}`}</button>
          </div>
        </section>
        {remoteStatus.configured && <section className="publish-box" aria-label="Private dashboard status">
          <p className="status-label">DASHBOARD STATUS</p>
          <div className={`dashboard-state ${remoteStatus.published || publishSucceeded ? 'is-published' : ''}`} role="status">
            <strong>{remoteStatus.published || publishSucceeded ? 'Published' : 'Not published'}</strong>
            {(remoteStatus.published || publishSucceeded) && <span>View only</span>}
          </div>
          <button className="publish-update" disabled={publishPending} onClick={() => void publishRemote()}>{publishPending ? 'Publishing…' : remoteStatus.published || publishSucceeded ? 'Publish update' : 'Publish dashboard'}</button>
          {publishMessage && !publishSucceeded && <p className="publish-message error-message" role="status">{publishMessage}</p>}
          {remoteStatus.siteUrl && <a className="remote-link" href={remoteStatus.siteUrl} target="_blank" rel="noreferrer">Open private dashboard ↗</a>}
        </section>}
      </div>
    </header>
    {error && <p className="error">{error}</p>}
    {!error && jobs.length === 0 && <p className="empty">No runs yet. Start with <code>ct demo</code>.</p>}
    <section className="grid">{jobs.map((job) => <JobCardView key={job.id} job={job} onOpen={() => openJob(job.id)} />)}</section>
    {selectedJobId !== null && <JobDrawer detail={detail} onClose={() => { setSelectedJobId(null); setDetail(null); }} onChanged={refreshSelected} />}
  </main>;
}

function JobCardView({ job, onOpen }: { job: JobCard; onOpen: () => void }) {
  const max = Math.max(...job.recent_durations, 1);
  return <article className="card" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onOpen(); }}>
    <div className="card-head"><span className={`dot ${job.state}`} /><h2>{job.name}</h2><span className={`state ${job.state}-text`}>{job.state}</span></div>
    <p className="description">{job.description}</p>
    <div className="spark" aria-label="Recent run durations">{job.recent_durations.map((duration, index) => <i key={index} style={{ height: `${Math.max(12, duration / max * 100)}%` }} />)}</div>
    <div className="uptime"><span>30D</span><div aria-label="Thirty-day run history">{job.uptime_days.map((day) => <i key={day.date} className={day.state} title={`${day.date}: ${day.state === 'empty' ? 'no run' : day.state}`} />)}</div></div>
    <dl><div><dt>LAST RUN</dt><dd>{job.last_run_at ? relativeTime(job.last_run_at) : 'never'}</dd></div><div><dt>DURATION</dt><dd>{formatDuration(job.last_duration_ms)}</dd></div><div><dt>RUNS</dt><dd>{job.run_count}</dd></div></dl>
    {job.open_incident_id && <p className="incident">INCIDENT #{job.open_incident_id} · {job.open_incident_kind}</p>}
    <code className="command">{job.command}</code>
  </article>;
}

function JobDrawer({ detail, onClose, onChanged }: { detail: JobDetail | null; onClose: () => void; onChanged: () => Promise<void> }) {
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="drawer" aria-label="Job details">
      <button className="close" onClick={onClose} aria-label="Close job details">×</button>
      {!detail ? <p className="loading">Loading job evidence…</p> : <>
        <p className="eyebrow">JOB #{detail.id} · {detail.state}</p>
        <h2>{detail.name}</h2>
        <p className="drawer-description">{detail.description}</p>
        <code className="drawer-command">{detail.command}</code>
        <section className="drawer-section">
          <h3>Incident history</h3>
          {detail.incidents.length === 0
            ? <p className="muted">No incidents in this cron’s history.</p>
            : <div className="incident-history">{detail.incidents.map((incident) => <IncidentHistoryRow key={incident.id} incident={incident} job={detail} onChanged={onChanged} />)}</div>}
        </section>
        <section className="drawer-section">
          <h3>Recent runs</h3>
          <div className="run-table">{detail.runs.slice(0, 12).map((run) => <div className="run-row" key={run.id}>
            <span className={run.exit_code === 0 ? 'run-ok' : 'run-failed'}>{run.exit_code === 0 ? 'PASS' : `EXIT ${run.exit_code}`}</span>
            <time>{new Date(run.started_at).toLocaleString()}</time><span>{formatDuration(run.duration_ms)}</span>
          </div>)}</div>
          {detail.runs[0] && <><h4>Latest log tail</h4><pre className="log-tail">{detail.runs[0].log_tail || '(no output)'}</pre></>}
        </section>
      </>}
    </aside>
  </div>;
}

function IncidentHistoryRow({ incident, job, onChanged }: { incident: IncidentDetail; job: JobDetail; onChanged: () => Promise<void> }) {
  const active = incident.status === 'open' || incident.status === 'proposed';
  const [expanded, setExpanded] = useState(active);
  return <div className={`incident-history-item ${active ? 'active' : ''}`}>
    <button className="incident-history-row" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <span className={active ? 'incident-active' : 'incident-resolved'}>{active ? 'ATTENTION' : 'RESOLVED'}</span>
      <span><strong>{incident.kind}</strong><time>{new Date(incident.opened_at).toLocaleString()}</time></span>
      <span className={`history-status ${incident.status}`}>{incident.status}</span>
      <span className="history-chevron" aria-hidden="true">{expanded ? '−' : '+'}</span>
    </button>
    {expanded && <IncidentCard incident={incident} job={job} onChanged={onChanged} />}
  </div>;
}

function IncidentCard({ incident, job, onChanged }: { incident: IncidentDetail; job: JobDetail; onChanged: () => Promise<void> }) {
  const proposal = incident.proposal;
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<'approve' | 'dismiss' | 'retry' | null>(null);
  const [actionError, setActionError] = useState('');
  const [copied, setCopied] = useState(false);
  const act = async (action: 'approve' | 'dismiss') => {
    if (action === 'dismiss' && !reason.trim()) { setActionError('Enter a dismissal reason.'); return; }
    setPending(action); setActionError('');
    try {
      const response = await mutate(`/api/incidents/${incident.id}/${action}`, {
        headers: action === 'dismiss' ? { 'content-type': 'application/json' } : undefined,
        body: action === 'dismiss' ? JSON.stringify({ reason }) : undefined
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `${action} failed`);
      await onChanged();
    } catch (error) { setActionError(error instanceof Error ? error.message : `${action} failed`); }
    finally { setPending(null); }
  };
  const codexPrompt = proposal?.fix_kind === 'command' ? buildCodexApplyPrompt(job, incident, proposal) : '';
  const copyCodexPrompt = async () => {
    if (!proposal) return;
    try {
      await navigator.clipboard.writeText(codexPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch { setActionError('Could not copy automatically. Select the Codex prompt below and copy it manually.'); }
  };
  const retryDiagnosis = async () => {
    setPending('retry'); setActionError('');
    try {
      const response = await mutate(`/api/incidents/${incident.id}/retry-diagnosis`);
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Retry diagnosis failed');
      await onChanged();
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Retry diagnosis failed'); }
    finally { setPending(null); }
  };
  const actionable = proposal?.model === 'gpt-5.6' && !proposal.applied_at && (incident.status === 'proposed' || incident.status === 'open');
  return <article className="incident-card">
    <div className="incident-heading"><span>#{incident.id} · {incident.kind}</span><span className={`incident-status ${incident.status}`}>{incident.status}</span></div>
    <p className="timeline-line">Opened {new Date(incident.opened_at).toLocaleString()}</p>
    {!proposal && <p className="diagnosing">GPT-5.6 is reading the evidence…</p>}
    {proposal && <ProposalCard proposal={proposal} />}
    {proposal?.model === 'error' && (incident.status === 'open' || incident.status === 'proposed') && <div className="retry-diagnosis">
      <button disabled={pending !== null} onClick={() => void retryDiagnosis()}>{pending === 'retry' ? 'Retrying diagnosis…' : 'Retry diagnosis'}</button>
      <p>Retries the diagnosis and skeptic pass with bounded backoff. No fix is applied by this button.</p>
      {actionError && <p className="action-error">{actionError}</p>}
    </div>}
    {proposal?.applied_at && incident.status === 'open' && <p className="diagnosing">The rerun still failed. The command was rolled back and GPT-5.6 is reviewing the new evidence…</p>}
    {actionable && proposal.fix_kind === 'command' && <div className="manual-apply">
      <strong>MANUAL SCHEDULER CHANGE</strong>
      <p>Crontrol can safely apply fixes to files it runs, but this proposal changes how cron or a service launches the job. Crontrol does not own that scheduler definition, so changing only its ledger would be temporary and misleading.</p>
      <p>Copy the prompt below into Codex. Codex will locate the real scheduler entry, explain and back up the exact change, ask for your approval, and validate it after applying.</p>
      <pre className="codex-prompt">{codexPrompt}</pre>
      <button onClick={() => void copyCodexPrompt()}>{copied ? 'Codex prompt copied ✓' : 'Copy Codex prompt'}</button>
    </div>}
    {actionable && <div className="actions">
      {proposal.fix_kind !== 'command' && <button className="approve" disabled={pending !== null} onClick={() => void act('approve')}>{pending === 'approve' ? 'Applying and rerunning…' : `Approve ${proposal.fix_kind}`}</button>}
      <div className="dismiss-row"><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason for dismissal" /><button disabled={pending !== null} onClick={() => void act('dismiss')}>{pending === 'dismiss' ? 'Dismissing…' : 'Dismiss'}</button></div>
      {actionError && <p className="action-error">{actionError}</p>}
    </div>}
    {incident.closed_at && <p className="timeline-line">Closed {new Date(incident.closed_at).toLocaleString()}</p>}
  </article>;
}

function ProposalCard({ proposal }: { proposal: ProposalRow }) {
  if (proposal.model === 'unavailable' || proposal.model === 'error') return <div className="key-missing">
    <strong>{proposal.model === 'unavailable' ? 'Diagnosis needs an API key' : 'Diagnosis unavailable'}</strong>
    <p>{proposal.root_cause}</p>
  </div>;
  return <div className="proposal">
    <p className="model-footer">DIAGNOSED BY {proposal.model}</p>
    <h4>Root cause</h4><p>{proposal.root_cause}</p>
    <h4>Evidence</h4><div className="evidence-list">{proposal.evidence.map((item, index) => <div key={index}><code>{item.line}</code><p>{item.why_it_matters}</p></div>)}</div>
    <div className="proposal-meta"><span className={`risk ${proposal.risk}`}>{proposal.risk} risk</span><span>{Math.round(proposal.confidence * 100)}% confidence</span></div>
    <h4>Proposed {proposal.fix_kind} fix</h4><p>{proposal.fix_explanation}</p><pre className="fix-body">{proposal.fix_body}</pre>
    <div className={proposal.review_verified ? 'review verified' : 'review objection'}><strong>{proposal.review_verified ? '✓ Verified by second pass' : '△ Second-pass objection'}</strong><p>{proposal.review_verdict}</p></div>
    {proposal.apply_result && <ApplyResult value={proposal.apply_result} />}
    {proposal.dismiss_reason && <p className="dismissed-reason">Dismissed: {proposal.dismiss_reason}</p>}
  </div>;
}

function ApplyResult({ value }: { value: string }) {
  let result: { fix?: { ok?: boolean }; rerun?: { runId?: number; exitCode?: number } } | null = null;
  try { result = JSON.parse(value) as typeof result; } catch { /* stored legacy text */ }
  const verified = result?.fix?.ok === true && result.rerun?.exitCode === 0;
  return <div className={`resolution ${verified ? 'verified' : 'failed'}`} role="status">
    <span className="resolution-mark" aria-hidden="true">{verified ? '✓' : '!'}</span>
    <div>
      <strong>{verified ? 'Fixed and verified' : 'Verification did not pass'}</strong>
      <p>{verified
        ? 'The approved fix was applied and the verification run completed successfully.'
        : 'Crontrol kept this incident open so the new evidence can be reviewed safely.'}</p>
    </div>
  </div>;
}

function buildCodexApplyPrompt(job: JobDetail, incident: IncidentDetail, proposal: ProposalRow): string {
  return `Help me safely apply a Crontrol scheduler command fix for incident #${incident.id}.

Job: ${job.name}
Job working directory: ${job.cwd}
Why Crontrol proposed this: ${proposal.root_cause}
Proposed replacement command:
${proposal.fix_body}

Crontrol did not apply this automatically because the command lives in a cron, LaunchAgent, systemd unit, or another scheduler definition that Crontrol does not own. Updating only Crontrol's recorded command would not be durable.

Please do the following:
1. Read AGENTS.md and START-HERE.md in the Crontrol repository if they exist.
2. Discover scheduled jobs read-only with the repository's ct discover --json command. Do not change or execute anything yet.
3. Locate the one real scheduler entry that launches this job. If it is missing or ambiguous, stop and ask me.
4. Explain in plain language why the command must change, show the exact before-and-after scheduler definition, and identify anything that could break.
5. Create a restorable backup of the scheduler definition.
6. Ask for my explicit approval before editing, reloading, enabling, or disabling the scheduler.
7. After approval, apply only the shown command change and validate the scheduler syntax/configuration.
8. Do not run the job as a test unless I separately approve that execution; it may have real side effects.
9. Tell me how to restore the backup and how the next scheduled run will report back to Crontrol.

Keep secrets out of chat and command output. Do not claim the fix is complete until the real scheduler definition—not just Crontrol's ledger—contains the approved command.`;
}

function relativeTime(value: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
function formatDuration(value: number | null) {
  if (value === null) return '—';
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
