import { addViewer, listMembers, membershipFor, removeViewer } from "../../../db/access";
import { getChatGPTUser } from "../../chatgpt-auth";

export const dynamic = "force-dynamic";

async function ownerForRequest() {
  const user = await getChatGPTUser();
  if (!user) return { error: Response.json({ error: "Sign in required" }, { status: 401 }) };
  const membership = await membershipFor(user.email);
  if (membership?.role !== "owner") return { error: Response.json({ error: "Owner access required" }, { status: 403 }) };
  return { user };
}

function trustedMutation(request: Request): boolean {
  const origin = request.headers.get("origin");
  return Boolean(origin && origin === new URL(request.url).origin);
}

export async function GET() {
  const authorization = await ownerForRequest();
  if ("error" in authorization) return authorization.error;
  return Response.json({ members: await listMembers() }, { headers: { "cache-control": "private, no-store" } });
}

export async function POST(request: Request) {
  if (!trustedMutation(request)) return Response.json({ error: "Untrusted origin" }, { status: 403 });
  const authorization = await ownerForRequest();
  if ("error" in authorization) return authorization.error;
  try {
    const body = await request.json() as { email?: unknown };
    if (typeof body.email !== "string") throw new Error("Email is required.");
    return Response.json({ member: await addViewer(authorization.user.email, body.email) }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not add viewer" }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  if (!trustedMutation(request)) return Response.json({ error: "Untrusted origin" }, { status: 403 });
  const authorization = await ownerForRequest();
  if ("error" in authorization) return authorization.error;
  try {
    const email = new URL(request.url).searchParams.get("email");
    if (!email) throw new Error("Email is required.");
    await removeViewer(authorization.user.email, email);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not remove viewer" }, { status: 400 });
  }
}
