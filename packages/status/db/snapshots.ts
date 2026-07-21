import { desc, lte } from "drizzle-orm";
import { getDb } from ".";
import { snapshots } from "./schema";

export type PublishedJob = {
  name: string;
  description: string | null;
  state: "healthy" | "late" | "stale" | "failed" | "flapping" | "never";
  lastRunAt: string | null;
  lastDurationMs: number | null;
  runCount: number;
  incidentKind: "failure" | "stale" | "flapping" | null;
  uptimeDays: Array<{ date: string; state: "ok" | "failed" | "empty" }>;
};

export type PublishedSnapshot = {
  schemaVersion: 1;
  publishedAt: string;
  label: string;
  jobs: PublishedJob[];
};

const states = new Set(["healthy", "late", "stale", "failed", "flapping", "never"]);
const incidentKinds = new Set(["failure", "stale", "flapping"]);
const uptimeStates = new Set(["ok", "failed", "empty"]);

export function validateSnapshot(value: unknown): PublishedSnapshot {
  if (!value || typeof value !== "object") throw new Error("Snapshot must be an object.");
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) throw new Error("Unsupported snapshot version.");
  if (typeof candidate.publishedAt !== "string" || !Number.isFinite(Date.parse(candidate.publishedAt))) throw new Error("Invalid publish time.");
  if (typeof candidate.label !== "string" || candidate.label.trim().length < 1 || candidate.label.length > 80) throw new Error("Invalid fleet label.");
  if (!Array.isArray(candidate.jobs) || candidate.jobs.length > 100) throw new Error("Invalid jobs list.");

  const jobs = candidate.jobs.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid job.");
    const job = raw as Record<string, unknown>;
    if (typeof job.name !== "string" || job.name.length < 1 || job.name.length > 120) throw new Error("Invalid job name.");
    if (job.description !== null && (typeof job.description !== "string" || job.description.length > 500)) throw new Error("Invalid job description.");
    if (typeof job.state !== "string" || !states.has(job.state)) throw new Error("Invalid job state.");
    if (job.lastRunAt !== null && (typeof job.lastRunAt !== "string" || !Number.isFinite(Date.parse(job.lastRunAt)))) throw new Error("Invalid last run time.");
    if (job.lastDurationMs !== null && (typeof job.lastDurationMs !== "number" || !Number.isInteger(job.lastDurationMs) || job.lastDurationMs < 0)) throw new Error("Invalid duration.");
    if (typeof job.runCount !== "number" || !Number.isInteger(job.runCount) || job.runCount < 0) throw new Error("Invalid run count.");
    if (job.incidentKind !== null && (typeof job.incidentKind !== "string" || !incidentKinds.has(job.incidentKind))) throw new Error("Invalid incident kind.");
    if (!Array.isArray(job.uptimeDays) || job.uptimeDays.length > 30) throw new Error("Invalid uptime history.");
    const uptimeDays = job.uptimeDays.map((rawDay) => {
      if (!rawDay || typeof rawDay !== "object") throw new Error("Invalid uptime day.");
      const day = rawDay as Record<string, unknown>;
      if (typeof day.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(day.date)) throw new Error("Invalid uptime date.");
      if (typeof day.state !== "string" || !uptimeStates.has(day.state)) throw new Error("Invalid uptime state.");
      return { date: day.date, state: day.state } as PublishedJob["uptimeDays"][number];
    });
    return {
      name: job.name,
      description: job.description,
      state: job.state,
      lastRunAt: job.lastRunAt,
      lastDurationMs: job.lastDurationMs,
      runCount: job.runCount,
      incidentKind: job.incidentKind,
      uptimeDays,
    } as PublishedJob;
  });

  return { schemaVersion: 1, publishedAt: candidate.publishedAt, label: candidate.label.trim(), jobs };
}

export async function latestSnapshot(): Promise<PublishedSnapshot | null> {
  try {
    const [row] = await getDb().select().from(snapshots).orderBy(desc(snapshots.id)).limit(1);
    if (!row) return null;
    return {
      schemaVersion: 1,
      publishedAt: row.publishedAt,
      label: row.label,
      jobs: JSON.parse(row.jobsJson) as PublishedJob[],
    };
  } catch {
    return null;
  }
}

export async function saveSnapshot(snapshot: PublishedSnapshot): Promise<void> {
  const db = getDb();
  await db.insert(snapshots).values({
    publishedAt: snapshot.publishedAt,
    label: snapshot.label,
    jobsJson: JSON.stringify(snapshot.jobs),
  });
  const staleRows = await db.select({ id: snapshots.id }).from(snapshots).orderBy(desc(snapshots.id)).limit(1).offset(95);
  if (staleRows[0]) {
    await db.delete(snapshots).where(lte(snapshots.id, staleRows[0].id));
  }
}
