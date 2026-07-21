import { env } from "cloudflare:workers";

export type DashboardRole = "owner" | "viewer";

export type DashboardMember = {
  email: string;
  role: DashboardRole;
  addedAt: string | null;
  lastSeenAt: string | null;
};

function runtime() {
  return env as unknown as { DB: D1Database; CRONTROL_OWNER_EMAIL?: string };
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function configuredOwnerEmail(): string {
  const email = normalizeEmail(runtime().CRONTROL_OWNER_EMAIL ?? "");
  if (!email || !isEmail(email)) throw new Error("CRONTROL_OWNER_EMAIL is not configured.");
  return email;
}

export async function membershipFor(emailValue: string): Promise<DashboardMember | null> {
  const email = normalizeEmail(emailValue);
  const owner = configuredOwnerEmail();
  if (email === owner) return { email, role: "owner", addedAt: null, lastSeenAt: null };
  const row = await runtime().DB.prepare(
    "SELECT email, added_at AS addedAt, last_seen_at AS lastSeenAt FROM viewers WHERE email = ? LIMIT 1",
  ).bind(email).first<{ email: string; addedAt: string; lastSeenAt: string | null }>();
  if (!row) return null;
  await runtime().DB.prepare("UPDATE viewers SET last_seen_at = CURRENT_TIMESTAMP WHERE email = ?").bind(email).run();
  return { email: row.email, role: "viewer", addedAt: row.addedAt, lastSeenAt: row.lastSeenAt };
}

export async function listMembers(): Promise<DashboardMember[]> {
  const owner = configuredOwnerEmail();
  const result = await runtime().DB.prepare(
    "SELECT email, added_at AS addedAt, last_seen_at AS lastSeenAt FROM viewers ORDER BY added_at ASC",
  ).all<{ email: string; addedAt: string; lastSeenAt: string | null }>();
  return [
    { email: owner, role: "owner", addedAt: null, lastSeenAt: null },
    ...(result.results ?? []).map((row) => ({ ...row, role: "viewer" as const })),
  ];
}

export async function addViewer(actorEmail: string, targetValue: string): Promise<DashboardMember> {
  const actor = normalizeEmail(actorEmail);
  const target = normalizeEmail(targetValue);
  if (!isEmail(target)) throw new Error("Enter a valid ChatGPT account email.");
  if (target === configuredOwnerEmail()) throw new Error("The owner already has access.");
  await runtime().DB.batch([
    runtime().DB.prepare(
      "INSERT INTO viewers (email, added_by) VALUES (?, ?) ON CONFLICT(email) DO NOTHING",
    ).bind(target, actor),
    runtime().DB.prepare(
      "INSERT INTO access_audit (actor_email, action, target_email) VALUES (?, 'viewer_added', ?)",
    ).bind(actor, target),
  ]);
  return { email: target, role: "viewer", addedAt: new Date().toISOString(), lastSeenAt: null };
}

export async function removeViewer(actorEmail: string, targetValue: string): Promise<void> {
  const actor = normalizeEmail(actorEmail);
  const target = normalizeEmail(targetValue);
  if (target === configuredOwnerEmail()) throw new Error("The owner cannot be removed.");
  await runtime().DB.batch([
    runtime().DB.prepare("DELETE FROM viewers WHERE email = ?").bind(target),
    runtime().DB.prepare(
      "INSERT INTO access_audit (actor_email, action, target_email) VALUES (?, 'viewer_removed', ?)",
    ).bind(actor, target),
  ]);
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) && value.length <= 254;
}
