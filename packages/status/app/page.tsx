import { getChatGPTUser } from "./chatgpt-auth";
import { latestSnapshot } from "../db/snapshots";
import { StatusDashboard } from "./StatusDashboard";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [snapshot, user] = await Promise.all([latestSnapshot(), getChatGPTUser()]);
  return <StatusDashboard initialSnapshot={snapshot} viewer={user?.displayName ?? null} />;
}
