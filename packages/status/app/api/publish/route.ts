import { env } from "cloudflare:workers";
import { saveSnapshot, validateSnapshot } from "../../../db/snapshots";

export async function POST(request: Request) {
  const runtime = env as unknown as { CRONTROL_PUBLISH_TOKEN?: string };
  const expected = runtime.CRONTROL_PUBLISH_TOKEN;
  const supplied = request.headers.get("authorization");
  if (!expected || supplied !== `Bearer ${expected}`) {
    return Response.json({ error: "Unauthorized publisher" }, { status: 401 });
  }

  try {
    const snapshot = validateSnapshot(await request.json());
    await saveSnapshot(snapshot);
    return Response.json({ ok: true, publishedAt: snapshot.publishedAt }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid snapshot" },
      { status: 400 },
    );
  }
}
