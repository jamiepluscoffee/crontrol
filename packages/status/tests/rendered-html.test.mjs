import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("builds the private Crontrol status application", async () => {
  await access(new URL("../dist/server/index.js", import.meta.url));
  const [page, dashboard, layout] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/StatusDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /Crontrol Private Status/);
  assert.match(page, /latestSnapshot/);
  assert.match(dashboard, /Your private cron view is ready\./);
  assert.match(dashboard, /OWNER ONLY/);
  assert.match(dashboard, /ct publish/);
  assert.doesNotMatch(`${page}\n${dashboard}\n${layout}`, /codex-preview|react-loading-skeleton/i);
});
