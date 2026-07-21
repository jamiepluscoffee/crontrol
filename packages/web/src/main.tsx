import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { JobCard } from '@crontrol/shared';
import './styles.css';

function App() {
  const [jobs, setJobs] = useState<JobCard[]>([]);
  const [error, setError] = useState('');
  const [chaosPending, setChaosPending] = useState(false);
  const loadJobs = () => fetch('/api/jobs').then((response) => {
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return response.json() as Promise<{ jobs: JobCard[] }>;
  }).then((data) => { setJobs(data.jobs); setError(''); });
  useEffect(() => {
    void loadJobs().catch((reason: Error) => setError(reason.message));
    const events = new EventSource('/api/events');
    const refresh = () => void loadJobs().catch((reason: Error) => setError(reason.message));
    events.addEventListener('ready', refresh);
    events.addEventListener('run', refresh);
    events.addEventListener('job', refresh);
    events.addEventListener('jobs', refresh);
    events.addEventListener('incident', refresh);
    events.onerror = () => setError((current) => current || 'Live updates disconnected; retrying…');
    return () => events.close();
  }, []);
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
  return <main>
    <header>
      <div><p className="eyebrow">LOCAL SUPERVISOR · RUN LEDGER</p><h1>Crontrol</h1></div>
      <div className="fleet"><span>{jobs.length} jobs</span><span className="healthy">{healthy} healthy</span><span className={openIncidents ? 'incident-count' : ''}>{openIncidents} open</span><button disabled={chaosPending} onClick={() => void triggerChaos()}>{chaosPending ? 'Breaking…' : 'Trigger chaos'}</button></div>
    </header>
    {error && <p className="error">Could not load jobs: {error}</p>}
    {!error && jobs.length === 0 && <p className="empty">No runs yet. Start with <code>ct demo</code>.</p>}
    <section className="grid">{jobs.map((job) => <JobCardView key={job.id} job={job} />)}</section>
  </main>;
}

function JobCardView({ job }: { job: JobCard }) {
  const max = Math.max(...job.recent_durations, 1);
  return <article className="card">
    <div className="card-head"><span className={`dot ${job.state}`} /><h2>{job.name}</h2><span className={`state ${job.state}-text`}>{job.state}</span></div>
    <p className="description">{job.description}</p>
    <div className="spark" aria-label="Recent run durations">{job.recent_durations.map((duration, index) => <i key={index} style={{ height: `${Math.max(12, duration / max * 100)}%` }} />)}</div>
    <dl><div><dt>LAST RUN</dt><dd>{job.last_run_at ? relativeTime(job.last_run_at) : 'never'}</dd></div><div><dt>DURATION</dt><dd>{formatDuration(job.last_duration_ms)}</dd></div><div><dt>RUNS</dt><dd>{job.run_count}</dd></div></dl>
    {job.open_incident_id && <p className="incident">INCIDENT #{job.open_incident_id} · {job.open_incident_kind}</p>}
    <code className="command">{job.command}</code>
  </article>;
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
