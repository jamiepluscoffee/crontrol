import { latestSnapshot } from "../../../db/snapshots";
import { membershipFor } from "../../../db/access";
import { getChatGPTUser } from "../../chatgpt-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  if (!await membershipFor(user.email)) return Response.json({ error: "Dashboard access required" }, { status: 403 });
  return Response.json(
    { snapshot: await latestSnapshot() },
    { headers: { "cache-control": "private, no-store" } },
  );
}
