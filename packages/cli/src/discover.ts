import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { redactSecrets } from '@crontrol/shared';

export type DiscoveredSchedule = {
  source: 'crontab' | 'launchd';
  label: string;
  schedule: string;
  command: string;
  location: string;
  alreadyMonitored: boolean;
};

export type DiscoveryResult = {
  jobs: DiscoveredSchedule[];
  warnings: string[];
};

type DiscoverDependencies = {
  platform?: NodeJS.Platform;
  home?: string;
  readCrontab?: () => string;
  listLaunchAgents?: (directory: string) => string[];
  readLaunchAgent?: (path: string) => unknown;
};

const CRON_MACROS = new Set([
  '@reboot', '@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly'
]);

export function discoverSchedules(dependencies: DiscoverDependencies = {}): DiscoveryResult {
  const jobs: DiscoveredSchedule[] = [];
  const warnings: string[] = [];
  const home = dependencies.home ?? homedir();
  const platform = dependencies.platform ?? process.platform;

  try {
    const crontab = (dependencies.readCrontab ?? readCurrentCrontab)();
    jobs.push(...parseCrontab(crontab));
  } catch (error) {
    if (!isMissingCrontab(error)) warnings.push(`Could not inspect the current user's crontab: ${errorMessage(error)}`);
  }

  if (platform === 'darwin') {
    const directory = join(home, 'Library', 'LaunchAgents');
    let files: string[] = [];
    try {
      files = (dependencies.listLaunchAgents ?? listLaunchAgents)(directory);
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'ENOENT') warnings.push(`Could not inspect macOS LaunchAgents: ${errorMessage(error)}`);
    }
    for (const file of files.filter((entry) => entry.endsWith('.plist')).sort()) {
      const path = join(directory, file);
      try {
        const definition = (dependencies.readLaunchAgent ?? readLaunchAgent)(path);
        const parsed = parseLaunchAgent(definition, path);
        if (parsed) jobs.push(parsed);
      } catch (error) {
        warnings.push(`Could not read LaunchAgent ${file}: ${errorMessage(error)}`);
      }
    }
  }

  return { jobs, warnings };
}

export function parseCrontab(contents: string): DiscoveredSchedule[] {
  const jobs: DiscoveredSchedule[] = [];
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) continue;

    const parts = line.split(/\s+/);
    let schedule: string;
    let command: string;
    if (CRON_MACROS.has(parts[0]?.toLowerCase())) {
      schedule = parts[0];
      command = parts.slice(1).join(' ');
    } else if (parts.length >= 6) {
      schedule = parts.slice(0, 5).join(' ');
      command = parts.slice(5).join(' ');
    } else {
      continue;
    }
    if (!command) continue;
    jobs.push({
      source: 'crontab',
      label: monitoredName(command) ?? `crontab line ${index + 1}`,
      schedule,
      command: redactSecrets(command),
      location: 'user crontab',
      alreadyMonitored: isCrontrolCommand(command)
    });
  }
  return jobs;
}

export function parseLaunchAgent(definition: unknown, path: string): DiscoveredSchedule | null {
  if (!definition || typeof definition !== 'object') return null;
  const value = definition as Record<string, unknown>;
  const argumentsValue = Array.isArray(value.ProgramArguments)
    ? value.ProgramArguments.filter((item): item is string => typeof item === 'string')
    : [];
  const command = argumentsValue.length > 0
    ? argumentsValue.map(shellQuote).join(' ')
    : typeof value.Program === 'string' ? shellQuote(value.Program) : '';
  if (!command) return null;

  const label = typeof value.Label === 'string' && value.Label.trim() ? value.Label.trim() : basename(path, '.plist');
  return {
    source: 'launchd',
    label,
    schedule: describeLaunchdSchedule(value),
    command: redactSecrets(command),
    location: path,
    alreadyMonitored: isCrontrolCommand(command)
  };
}

function readCurrentCrontab(): string {
  return execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function listLaunchAgents(directory: string): string[] {
  return readdirSync(directory);
}

function readLaunchAgent(path: string): unknown {
  const output = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  return JSON.parse(output) as unknown;
}

function describeLaunchdSchedule(value: Record<string, unknown>): string {
  if (typeof value.StartInterval === 'number') return `every ${value.StartInterval}s`;
  if (value.StartCalendarInterval) {
    const entries = Array.isArray(value.StartCalendarInterval) ? value.StartCalendarInterval : [value.StartCalendarInterval];
    return entries.map(describeCalendarInterval).join('; ');
  }
  if (value.RunAtLoad === true) return 'at login/load';
  if (value.KeepAlive) return 'kept alive';
  return 'event-triggered';
}

function describeCalendarInterval(value: unknown): string {
  if (!value || typeof value !== 'object') return 'calendar schedule';
  const fields = value as Record<string, unknown>;
  const names: Record<string, string> = { Month: 'month', Day: 'day', Weekday: 'weekday', Hour: 'hour', Minute: 'minute' };
  const parts = Object.entries(names)
    .filter(([key]) => typeof fields[key] === 'number')
    .map(([key, name]) => `${name} ${fields[key]}`);
  return parts.length ? parts.join(', ') : 'calendar schedule';
}

function isCrontrolCommand(command: string): boolean {
  return /(?:^|[\s/])(?:ct|crontrol)\s+run(?:\s|$)/.test(command);
}

function monitoredName(command: string): string | null {
  const match = command.match(/(?:^|[\s/])(?:ct|crontrol)\s+run\s+[^\n]*?--name(?:=|\s+)(?:['"]([^'"]+)['"]|([^\s]+))/);
  return match?.[1] ?? match?.[2] ?? null;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function isMissingCrontab(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: number; stderr?: Buffer | string };
  const stderr = candidate.stderr?.toString().toLowerCase() ?? '';
  return candidate.status === 1 && /no crontab/.test(stderr);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
}
