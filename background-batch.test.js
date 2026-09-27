import test from "node:test";
import assert from "node:assert/strict";

test("batch and scheduled checks share work and respect concurrency", async () => {
  const values = new Map();
  let handler, alarmHandler, tabId = 0, active = 0, maximum = 0, opened = 0;
  const tabUrls = new Map();
  let failingUrl = null;
  const event = () => ({ addListener() {}, removeListener() {} });
  globalThis.chrome = {
    runtime: { onInstalled: event(), onStartup: event(), onMessage: { addListener(fn) { handler = fn; } } },
    alarms: { onAlarm: { addListener(fn) { alarmHandler = fn; } }, async get() { return {}; } },
    notifications: { onClicked: event(), async create() {} },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    tabs: {
      onUpdated: event(), onRemoved: event(),
      async create(options) { active++; opened++; maximum = Math.max(maximum, active); tabUrls.set(++tabId, options.url); return { id: tabId }; },
      async get(id) { return { id, status: "complete" }; },
      async remove() { active--; }
    },
    scripting: { async executeScript(args) {
      if (args.files) return [];
      if (tabUrls.get(args.target.tabId) === failingUrl) throw new Error("fetch failed");
      return [{ result: { text: "sample", title: "Page" } }];
    } },
    storage: { local: {
      async get(key) { return key === null ? Object.fromEntries(values) : { [key]: values.get(key) }; },
      async set(entries) { for (const [key, value] of Object.entries(entries)) values.set(key, value); },
      async remove(key) { values.delete(key); }
    } }
  };
  await import("./background.js");
  const request = (type, payload = {}) => new Promise(resolve => handler({ type, ...payload }, {}, resolve));
  for (let n = 0; n < 3; n++) {
    assert.equal((await request("create", { monitor: { url: "https://example.org/"+n } })).ok, true);
  }
  await request("setScanConcurrency", { count: 2 });
  const started = await request("startBatch", { scope: "all" });
  assert.equal(started.value.ids.length, 3);
  alarmHandler({ name: "scan-due-monitors" });
  let job;
  for (let i = 0; i < 50; i++) {
    job = (await request("getBatchJob")).value;
    if (job.status === "done") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(job.status, "done");
  assert.equal(job.done, 3);
  assert.equal(job.failed, 0);
  assert.equal(opened, 3);
  assert.ok(maximum <= 2, "maximum concurrent tabs: "+maximum);
  assert.equal(active, 0);

  const targetId = started.value.ids[0];
  const key = "monitor:"+targetId;
  values.set(key, { ...values.get(key), status: "error", error: "old error" });
  failingUrl = values.get(key).url;
  const errorBatch = await request("startBatch", { scope: "error" });
  assert.deepEqual(errorBatch.value.ids, [targetId]);
  for (let i = 0; i < 30; i++) {
    job = (await request("getBatchJob")).value;
    if (job.status === "done") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(job.done, 1);
  assert.equal(job.failed, 1);
});
