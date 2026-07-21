import type Database from 'better-sqlite3';
import { listJobCards } from '@crontrol/shared';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface PublishedSnapshot {
  schemaVersion: 1;
  publishedAt: string;
  label: string;
  jobs: Array<{
    name: string;
    description: string | null;
    state: string;
    lastRunAt: string | null;
    lastDurationMs: number | null;
    runCount: number;
    incidentKind: string | null;
    uptimeDays: Array<{ date: string; state: 'ok' | 'failed' | 'empty' }>;
  }>;
}

export interface PublishConfiguration {
  configured: boolean;
  siteUrl: string | null;
  published: boolean;
}

interface StoredPublishConfiguration {
  siteUrl: string;
  publishToken: string;
  sitesToken?: string;
  label?: string;
  lastPublishedAt?: string;
}

function configurationPath(environment: NodeJS.ProcessEnv): string {
  return environment.CRONTROL_PUBLISH_CONFIG ?? join(homedir(), '.crontrol', 'publish.json');
}

function storedConfiguration(environment: NodeJS.ProcessEnv): StoredPublishConfiguration | null {
  try {
    return JSON.parse(readFileSync(configurationPath(environment), 'utf8')) as StoredPublishConfiguration;
  } catch { return null; }
}

function resolvedConfiguration(environment: NodeJS.ProcessEnv): StoredPublishConfiguration | null {
  const stored = storedConfiguration(environment);
  const siteUrl = environment.CRONTROL_STATUS_URL?.trim() || stored?.siteUrl;
  const publishToken = environment.CRONTROL_PUBLISH_TOKEN?.trim() || stored?.publishToken;
  if (!siteUrl || !publishToken) return null;
  return {
    siteUrl,
    publishToken,
    sitesToken: environment.CRONTROL_SITES_TOKEN?.trim() || stored?.sitesToken,
    label: environment.CRONTROL_PUBLISH_LABEL?.trim() || stored?.label,
    lastPublishedAt: stored?.lastPublishedAt,
  };
}

function writeStoredConfiguration(configuration: StoredPublishConfiguration, environment: NodeJS.ProcessEnv): string {
  const path = configurationPath(environment);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(configuration, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function savePublicationConfiguration(environment: NodeJS.ProcessEnv = process.env): string {
  const siteUrl = environment.CRONTROL_STATUS_URL?.trim();
  const publishToken = environment.CRONTROL_PUBLISH_TOKEN?.trim();
  if (!siteUrl || !publishToken) throw new Error('Set CRONTROL_STATUS_URL and CRONTROL_PUBLISH_TOKEN before using --configure.');
  const parsed = new URL(siteUrl);
  if (parsed.protocol !== 'https:') throw new Error('CRONTROL_STATUS_URL must use HTTPS.');
  const previous = storedConfiguration(environment);
  return writeStoredConfiguration({
    siteUrl: parsed.origin,
    publishToken,
    sitesToken: environment.CRONTROL_SITES_TOKEN?.trim() || undefined,
    label: environment.CRONTROL_PUBLISH_LABEL?.trim() || undefined,
    lastPublishedAt: previous?.siteUrl === parsed.origin ? previous.lastPublishedAt : undefined,
  }, environment);
}

export function publicationConfiguration(environment: NodeJS.ProcessEnv = process.env): PublishConfiguration {
  const configuration = resolvedConfiguration(environment);
  const siteUrl = configuration?.siteUrl ?? null;
  return {
    configured: Boolean(siteUrl),
    siteUrl,
    published: Boolean(configuration?.lastPublishedAt),
  };
}

export function buildPublishedSnapshot(db: Database.Database, label = process.env.CRONTROL_PUBLISH_LABEL ?? 'My cron fleet'): PublishedSnapshot {
  return {
    schemaVersion: 1,
    publishedAt: new Date().toISOString(),
    label: label.trim().slice(0, 80) || 'My cron fleet',
    jobs: listJobCards(db).map((job) => ({
      name: job.name,
      description: job.description,
      state: job.state,
      lastRunAt: job.last_run_at,
      lastDurationMs: job.last_duration_ms,
      runCount: job.run_count,
      incidentKind: job.open_incident_kind,
      uptimeDays: job.uptime_days,
    })),
  };
}

export async function publishStatus(
  db: Database.Database,
  environment: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): Promise<{ publishedAt: string; jobs: number; siteUrl: string }> {
  const configuration = resolvedConfiguration(environment);
  if (!configuration) throw new Error('Private status is not configured. Set CRONTROL_STATUS_URL and CRONTROL_PUBLISH_TOKEN.');
  const { siteUrl, publishToken } = configuration;
  const base = new URL(siteUrl);
  if (base.protocol !== 'https:' && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1') throw new Error('CRONTROL_STATUS_URL must use HTTPS.');
  const endpoint = new URL('/api/publish', base).toString();
  const snapshot = buildPublishedSnapshot(db, configuration.label);
  const headers = new Headers({ authorization: `Bearer ${publishToken}`, 'content-type': 'application/json' });
  const sitesToken = configuration.sitesToken;
  if (sitesToken) headers.set('OAI-Sites-Authorization', `Bearer ${sitesToken}`);
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(snapshot),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Private status publish failed (${response.status}).`);
  const stored = storedConfiguration(environment);
  if (stored) writeStoredConfiguration({ ...stored, lastPublishedAt: snapshot.publishedAt }, environment);
  return { publishedAt: snapshot.publishedAt, jobs: snapshot.jobs.length, siteUrl: base.origin };
}
