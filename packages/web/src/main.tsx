import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { IncidentDetail, JobCard, JobDetail, ProposalRow } from '@crontrol/shared';
import './styles.css';

function App() {
  const [jobs, setJobs] = useState<JobCard[]>([]);
  const [error, setError] = useState('');
  const [chaosPending, setChaosPending] = useState(false);
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

  useEffect(() => {
    void loadJobs().catch((reason: Error) => setError(reason.message));
    const events = new EventSource('/api/events');
    const refresh = () => {
      void loadJobs().catch((reason: Error) => setError(reason.message));
      if (selectedJobId !== null) void loadDetail(selectedJobId).catch((reason: Error) => setError(reason.message));
    };
    for (const event of ['ready', 'run', 'job', 'jobs', 'incident', 'proposal', 'incident-closed']) events.addEventListener(event, refresh);
    events.onerror = () => setError((current) => current || 'Live updates disconnected; retrying…');
    return () => events.close();
  }, [loadDetail, loadJobs, selectedJobId]);

  const healthy = jobs.filter((job) => job.state === 'healthy').length;
  const openIncidents = jobs.filter((job) => job.open_incident_id !== null).length;
  const triggerChaos = async () => {
    setChaosPending(true);
    try {
      const response = await fetch('/api/chaos', { method: 'POST' });
      if (!response.ok) throw new Error(`Chaos failed (${response.status})`);
      await loadJobs();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Chaos failed');
    } finally { setChaosPending(false); }
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
      <section className="status-box" aria-label="Fleet status">
        <p className="status-label">STATUS</p>
        <dl className="status-values">
          <div><dt>Jobs</dt><dd>{jobs.length}</dd></div>
          <div><dt>Healthy</dt><dd className="healthy-value">{healthy}</dd></div>
          <div><dt>Needs attention</dt><dd className={openIncidents ? 'attention-value' : ''}>{openIncidents}</dd></div>
        </dl>
        <button className="chaos-button" disabled={chaosPending} onClick={() => void triggerChaos()}>{chaosPending ? 'Breaking…' : 'Trigger chaos'}</button>
      </section>
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
            : <div className="incident-history">{detail.incidents.map((incident) => <IncidentHistoryRow key={incident.id} incident={incident} onChanged={onChanged} />)}</div>}
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

function IncidentHistoryRow({ incident, onChanged }: { incident: IncidentDetail; onChanged: () => Promise<void> }) {
  const [expanded, setExpanded] = useState(false);
  const active = incident.status === 'open' || incident.status === 'proposed';
  return <div className={`incident-history-item ${active ? 'active' : ''}`}>
    <button className="incident-history-row" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <span className={active ? 'incident-active' : 'incident-resolved'}>{active ? 'ATTENTION' : 'RESOLVED'}</span>
      <span><strong>{incident.kind}</strong><time>{new Date(incident.opened_at).toLocaleString()}</time></span>
      <span className={`history-status ${incident.status}`}>{incident.status}</span>
      <span className="history-chevron" aria-hidden="true">{expanded ? '−' : '+'}</span>
    </button>
    {expanded && <IncidentCard incident={incident} onChanged={onChanged} />}
  </div>;
}

function IncidentCard({ incident, onChanged }: { incident: IncidentDetail; onChanged: () => Promise<void> }) {
  const proposal = incident.proposal;
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<'approve' | 'dismiss' | null>(null);
  const [actionError, setActionError] = useState('');
  const act = async (action: 'approve' | 'dismiss') => {
    if (action === 'dismiss' && !reason.trim()) { setActionError('Enter a dismissal reason.'); return; }
    setPending(action); setActionError('');
    try {
      const response = await fetch(`/api/incidents/${incident.id}/${action}`, {
        method: 'POST',
        headers: action === 'dismiss' ? { 'content-type': 'application/json' } : undefined,
        body: action === 'dismiss' ? JSON.stringify({ reason }) : undefined
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `${action} failed`);
      await onChanged();
    } catch (error) { setActionError(error instanceof Error ? error.message : `${action} failed`); }
    finally { setPending(null); }
  };
  return <article className="incident-card">
    <div className="incident-heading"><span>#{incident.id} · {incident.kind}</span><span className={`incident-status ${incident.status}`}>{incident.status}</span></div>
    <p className="timeline-line">Opened {new Date(incident.opened_at).toLocaleString()}</p>
    {!proposal && <p className="diagnosing">GPT-5.6 is reading the evidence…</p>}
    {proposal && <ProposalCard proposal={proposal} />}
    {proposal?.applied_at && incident.status === 'open' && <p className="diagnosing">The rerun still failed. The command was rolled back and GPT-5.6 is reviewing the new evidence…</p>}
    {proposal?.model === 'gpt-5.6' && !proposal.applied_at && (incident.status === 'proposed' || incident.status === 'open') && <div className="actions">
      <button className="approve" disabled={pending !== null} onClick={() => void act('approve')}>{pending === 'approve' ? 'Applying and rerunning…' : 'Approve fix'}</button>
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
  let formatted = value;
  try { formatted = JSON.stringify(JSON.parse(value), null, 2); } catch { /* stored legacy text */ }
  return <><h4>Action result</h4><pre className="apply-result">{formatted}</pre></>;
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
