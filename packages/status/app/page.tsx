import { chatGPTSignOutPath, requireChatGPTUser } from "./chatgpt-auth";
import { membershipFor } from "../db/access";
import { latestSnapshot } from "../db/snapshots";
import { StatusDashboard } from "./StatusDashboard";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireChatGPTUser("/");
  const membership = await membershipFor(user.email);
  if (!membership) return <main className="status-shell denied-state">
    <section className="waiting">
      <p className="kicker">ACCESS NOT GRANTED</p>
      <h1>This dashboard hasn’t been shared with you.</h1>
      <p>You signed in as <strong>{user.email}</strong>. Ask the dashboard owner to add this exact ChatGPT email, then refresh this page.</p>
      <a className="signout-link" href={chatGPTSignOutPath("/")}>Sign in with another account</a>
    </section>
  </main>;
  const snapshot = await latestSnapshot();
  return <StatusDashboard initialSnapshot={snapshot} viewer={user.displayName} viewerEmail={user.email} role={membership.role} />;
}
