import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("builds the private Crontrol status application", async () => {
  await access(new URL("../dist/server/index.js", import.meta.url));
  const [page, dashboard, layout, statusRoute, membersRoute, accessSource] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/StatusDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/status/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/members/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/access.ts", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /Crontrol Private Status/);
  assert.match(page, /requireChatGPTUser/);
  assert.match(page, /membershipFor/);
  assert.match(dashboard, /Your private cron view is ready\./);
  assert.match(dashboard, /Share this dashboard/);
  assert.match(dashboard, /Add viewer/);
  assert.match(dashboard, /ct publish/);
  assert.match(statusRoute, /membershipFor/);
  assert.match(membersRoute, /Owner access required/);
  assert.match(membersRoute, /Untrusted origin/);
  assert.match(accessSource, /CRONTROL_OWNER_EMAIL/);
  assert.match(accessSource, /access_audit/);
  assert.doesNotMatch(`${page}\n${dashboard}\n${layout}`, /codex-preview|react-loading-skeleton/i);
});
