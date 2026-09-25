import test from "node:test";
import assert from "node:assert/strict";

test("more than 25 monitors can be created and listed", async () => {
  const values = new Map();
  let handler;
  const event = () => ({ addListener() {} });
  globalThis.chrome = {
    runtime: { onInstalled: event(), onStartup: event(), onMessage: { addListener(fn) { handler = fn; } } },
    alarms: { onAlarm: event(), async get() { return {}; } },
    notifications: { onClicked: event() },
    storage: { local: {
      async get(key) {
        if (key === null) return Object.fromEntries(values);
        return { [key]: values.get(key) };
      },
      async set(entries) { for (const [key, value] of Object.entries(entries)) values.set(key, value); }
    } }
  };
  await import("./background.js");
  const request = (type, payload = {}) => new Promise(resolve => handler({ type, ...payload }, {}, resolve));
  for (let i = 0; i < 30; i++) {
    const result = await request("create", { monitor: { url: `https://example.com/${i}`, ignoreSelectors: i === 0 ? [".ad"] : [] } });
    assert.equal(result.ok, true);
  }
  const list = await request("list");
  assert.equal(list.ok, true);
  assert.equal(list.value.length, 30);
  assert.equal(new Set(list.value.map(item => item.id)).size, 30);
  const first = list.value.find(item => item.url.endsWith("/0"));
  assert.deepEqual(first.ignoreSelectors, [".ad"]);
  first.text = "baseline";
  values.set(`monitor:${first.id}`, first);
  const renamed = await request("update", { id: first.id, patch: { title: "Renamed" } });
  assert.equal(renamed.value.text, "baseline");
  const excluded = await request("update", { id: first.id, patch: { ignoreSelectors: ".ad\nfooter" } });
  assert.equal(excluded.value.text, null);
  assert.deepEqual(excluded.value.ignoreSelectors, [".ad", "footer"]);
  await request("update", { id: first.id, patch: { enabled: false } });
  const duplicated = await request("duplicate", { id: first.id });
  assert.equal(duplicated.ok, true);
  assert.notEqual(duplicated.value.id, first.id);
  assert.equal(duplicated.value.title, "Renamed (コピー)");
  assert.equal(duplicated.value.url, first.url);
  assert.deepEqual(duplicated.value.ignoreSelectors, [".ad", "footer"]);
  assert.equal(duplicated.value.enabled, false);
  assert.equal(duplicated.value.text, null);
  assert.deepEqual(duplicated.value.history, []);
  assert.equal((await request("list")).value.length, 31);

  const urls = ["https://example.com/new#part", "https://other.example.org/a", "https://other.example.org/a", first.url];
  const preview = await request("previewBulkDuplicate", { id: first.id, urls });
  assert.deepEqual(preview.value, { count: 2, skipped: 2 });
  const invalid = await request("bulkDuplicate", { id: first.id, urls: ["https://example.com/valid", "file:///bad"] });
  assert.equal(invalid.ok, false);
  assert.equal((await request("list")).value.length, 31);
  const bulk = await request("bulkDuplicate", { id: first.id, urls });
  assert.deepEqual(bulk.value, { created: 2, skipped: 2 });
  const copies = (await request("list")).value.filter(item => item.autoTitle);
  assert.equal(copies.length, 2);
  assert.deepEqual(new Set(copies.map(item => item.url)), new Set(["https://example.com/new", "https://other.example.org/a"]));
  for (const copy of copies) {
    assert.equal(copy.selector, first.selector);
    assert.deepEqual(copy.ignoreSelectors, first.ignoreSelectors);
    assert.equal(copy.intervalMinutes, first.intervalMinutes);
    assert.equal(copy.enabled, false);
    assert.equal(copy.text, null);
    assert.deepEqual(copy.history, []);
    assert.equal(copy.status, "new");
  }
  const again = await request("bulkDuplicate", { id: first.id, urls });
  assert.deepEqual(again.value, { created: 0, skipped: 4 });
  assert.equal((await request("list")).value.length, 33);
});
