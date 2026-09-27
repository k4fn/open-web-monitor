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
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    storage: { local: {
      async get(key) {
        if (key === null) return Object.fromEntries(values);
        return { [key]: values.get(key) };
      },
      async set(entries) { for (const [key, value] of Object.entries(entries)) values.set(key, value); },
      async remove(key) { values.delete(key); }
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
  const tagA = (await request("createTag", { name: "Forum" })).value;
  const tagB = (await request("createTag", { name: "Priority" })).value;
  const tagged = await request("update", { id: first.id, patch: { tagIds: [tagA.id, tagB.id] } });
  assert.deepEqual(tagged.value.tagIds, [tagA.id, tagB.id]);
  const taggedCopy = await request("duplicate", { id: first.id });
  assert.deepEqual(taggedCopy.value.tagIds, [tagA.id, tagB.id]);
  await request("renameTag", { id: tagA.id, name: "Community" });
  assert.equal((await request("listTags")).value.find(tag => tag.id === tagA.id).name, "Community");
  await request("deleteTag", { id: tagA.id });
  assert.deepEqual((await request("list")).value.find(item => item.id === first.id).tagIds, [tagB.id]);

  const beforeTrash = (await request("list")).value.find(item => item.id === first.id);
  await request("delete", { id: first.id });
  const trashed = (await request("list")).value.find(item => item.id === first.id);
  assert.ok(trashed.trashedAt);
  assert.equal(trashed.enabled, beforeTrash.enabled);
  assert.deepEqual(trashed.tagIds, beforeTrash.tagIds);
  await request("restore", { id: first.id });
  const restored = (await request("list")).value.find(item => item.id === first.id);
  assert.equal(restored.trashedAt, null);
  assert.equal(restored.enabled, false);
  const doomed = (await request("create", { monitor: { url: "https://example.net/doomed" } })).value;
  await request("delete", { id: doomed.id });
  await request("deletePermanently", { id: doomed.id });
  assert.equal((await request("list")).value.some(item => item.id === doomed.id), false);

  const legacy = await request("import", { items: [{ url: "https://legacy.example/a", selector: ".body" }] });
  assert.equal(legacy.value, 1);
  const modern = await request("import", { items: {
    version: 2, tags: [{ id: "old-id", name: "Imported" }],
    monitors: [{ url: "https://modern.example/b", tagIds: ["old-id"], trashedAt: 1, enabled: false }]
  } });
  assert.equal(modern.value, 1);
  const imported = (await request("list")).value.find(item => item.url === "https://modern.example/b");
  assert.ok(imported.trashedAt);
  assert.equal(imported.enabled, false);
  assert.equal((await request("listTags")).value.find(tag => tag.id === imported.tagIds[0]).name, "Imported");
  const invalidImport = await request("import", { items: { version: 2, tags: [], monitors: [{ url: "https://valid.example" }, { url: "file:///bad" }] } });
  assert.equal(invalidImport.ok, false);
  assert.equal((await request("list")).value.some(item => item.url === "https://valid.example/"), false);
  for (let i = 0; i < 24; i++) {
    values.set("monitor:legacy-"+i, {
      id: "legacy-"+i, url: "https://old.example/"+i, title: "Existing "+i,
      enabled: true, status: "ok", history: [], nextCheckAt: Date.now()+3600000,
      intervalMinutes: 60, selector: "", ignoreSelectors: [], text: "saved"
    });
  }
  const existing = (await request("list")).value.filter(item => item.id.startsWith("legacy-"));
  assert.equal(existing.length, 24);
  assert.ok(existing.every(item => !item.trashedAt && !item.tagIds?.length && item.text === "saved"));
});
