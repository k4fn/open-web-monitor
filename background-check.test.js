import test from "node:test";
import assert from "node:assert/strict";

test("empty content is a change and notification failures do not mark checks as failed", async () => {
  const values = new Map();
  let handler;
  let pageText = "first value";
  let pageTitle = "Example page";
  let beforeExtract = () => {};
  let openedTab;
  let openedWindow;
  let removedWindow;
  let removedTab;
  let pickerConfig;
  let alarmHandler;
  let tabCreateCount = 0;
  const emptyEvent = () => ({ addListener() {}, removeListener() {} });
  globalThis.chrome = {
    runtime: { onInstalled: emptyEvent(), onStartup: emptyEvent(), getURL(path) { return "chrome-extension://test/"+path; }, onMessage: { addListener(fn) { handler = fn; } } },
    alarms: { onAlarm: { addListener(fn) { alarmHandler = fn; } }, async get() { return {}; } },
    notifications: { onClicked: emptyEvent(), async create() { throw new Error("notifications disabled"); } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    tabs: {
      onUpdated: emptyEvent(), onRemoved: emptyEvent(), async create(options) { openedTab = options; tabCreateCount++; return { id: 1 }; },
      async get() { return { id: 1, status: "complete" }; },
      async query() { return [{ id: 2 }]; }, async remove(id) { removedTab = id; }
    },
    windows: {
      async create(options) { openedWindow = options; return { id: 5 }; },
      async remove(id) { removedWindow = id; }
    },
    scripting: { async executeScript(injection) {
      if (injection.files) return [];
      if (injection.args?.length === 1 && typeof injection.args[0] === "object") { pickerConfig = injection.args[0]; return []; }
      beforeExtract();
      return [{ result: { text: pageText, title: pageTitle } }];
    } },
    storage: { local: {
      async get(key) { return key === null ? Object.fromEntries(values) : { [key]: values.get(key) }; },
      async set(entries) { for (const [key, value] of Object.entries(entries)) values.set(key, value); }
    } }
  };
  await import("./background.js");
  const request = (type, payload = {}) => new Promise(resolve => handler({ type, ...payload }, {}, resolve));
  const created = await request("create", { monitor: { url: "https://example.com/" } });
  const id = created.value.id;
  const first = await request("check", { id });
  assert.deepEqual(openedTab, { url: "https://example.com/", active: false, pinned: true });
  assert.equal(removedTab, 1);
  assert.equal(first.value.text, "first value");
  assert.equal(first.value.history.length, 0);

  pageText = "";
  const second = await request("check", { id });
  assert.equal(second.value.status, "ok");
  assert.equal(second.value.text, "");
  assert.equal(second.value.history.length, 1);

  assert.equal((await request("setCheckMode", { mode: "window" })).value, "window");
  assert.equal((await request("getCheckMode")).value, "window");
  const windowCheck = await request("check", { id });
  assert.equal(windowCheck.ok, true);
  assert.deepEqual(openedWindow, { url: "https://example.com/", focused: false, type: "normal" });
  assert.equal(removedWindow, 5);
  assert.equal((await request("setCheckMode", { mode: "invalid" })).ok, false);
  await request("setCheckMode", { mode: "pinned-tab" });

  pageText = "stale result";
  beforeExtract = () => {
    const key = `monitor:${id}`;
    values.set(key, { ...values.get(key), selector: ".new", text: null });
    beforeExtract = () => {};
  };
  const third = await request("check", { id });
  assert.equal(third.value.selector, ".new");
  assert.equal(third.value.text, null);

  const navigated = await request("pickerNavigate", {
    url: "https://example.org/new#fragment",
    draft: { id, selector: ".new", ignoreSelectors: [".ad"] }
  });
  assert.equal(navigated.ok, true);
  assert.deepEqual(openedTab, { url: "https://example.org/new", active: true });
  assert.deepEqual(pickerConfig, { id, selector: ".new", ignoreSelectors: [".ad"] });
  const editor = await request("openEditor", { id });
  assert.equal(editor.ok, true);
  assert.deepEqual(openedTab, { url: "chrome-extension://test/dashboard.html#" + id, active: true });

  const bulk = await request("bulkDuplicate", { id, urls: ["https://example.net/one", "https://example.net/two"] });
  assert.deepEqual(bulk.value, { created: 2, skipped: 0 });
  const copies = (await request("list")).value.filter(item => item.autoTitle);
  const firstCopy = copies.find(item => item.url.endsWith("/one"));
  const secondCopy = copies.find(item => item.url.endsWith("/two"));
  pageTitle = "";
  await request("check", { id: firstCopy.id });
  const untitled = (await request("list")).value.find(item => item.id === firstCopy.id);
  assert.equal(untitled.title, "https://example.net/one");
  assert.equal(untitled.autoTitle, true);
  pageTitle = "First page title";
  await request("check", { id: firstCopy.id });
  assert.equal((await request("list")).value.find(item => item.id === firstCopy.id).title, "First page title");
  const edited = await request("update", { id: secondCopy.id, patch: { title: "Manual title" } });
  assert.equal(edited.value.autoTitle, false);
  pageTitle = "Would overwrite";
  await request("check", { id: secondCopy.id });
  assert.equal((await request("list")).value.find(item => item.id === secondCopy.id).title, "Manual title");
  const firstKey = `monitor:${firstCopy.id}`;
  const secondKey = `monitor:${secondCopy.id}`;
  values.set(firstKey, { ...values.get(firstKey), status: "error", error: "old failure" });
  await request("update", { id: secondCopy.id, patch: { enabled: false } });
  await request("delete", { id });
  const started = await request("startBatch", { scope: "error" });
  assert.equal(started.value.ids.length, 1);
  assert.deepEqual(started.value.ids, [firstCopy.id]);
  for (let i = 0; i < 30; i++) {
    if ((await request("getBatchJob")).value.status === "done") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const finished = (await request("getBatchJob")).value;
  assert.equal(finished.done, 1);
  assert.equal(finished.failed, 0);

  // A persisted partial job is resumed by the alarm without reopening completed monitors.
  await request("update", { id: secondCopy.id, patch: { enabled: true } });
  const resumed = {
    id: "resume-job", scope: "all", ids: [firstCopy.id, secondCopy.id],
    completed: { [firstCopy.id]: { failed: false, at: Date.now() } },
    done: 1, failed: 0, status: "running", startedAt: Date.now()
  };
  values.set("batchCheckJob", resumed);
  const beforeResume = tabCreateCount;
  alarmHandler({ name: "scan-due-monitors" });
  for (let i = 0; i < 30; i++) {
    if ((await request("getBatchJob")).value.status === "done") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const afterResume = (await request("getBatchJob")).value;
  assert.equal(afterResume.done, 2);
  assert.equal(afterResume.status, "done");
  assert.equal(tabCreateCount - beforeResume, 1);
});
