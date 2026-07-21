import { latestSnapshot } from "../../../db/snapshots";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    { snapshot: await latestSnapshot() },
    { headers: { "cache-control": "private, no-store" } },
  );
}
