import test from "node:test";
import assert from "node:assert/strict";
import { visibleMonitorsForView, openMonitorLinks } from "./watchlist.js";

test("visible links follow the current screen and search", () => {
  const items = [
    { id: "a", title: "Alpha", url: "https://a.example/", status: "ok", history: [{ read: false }], tagIds: ["t"], createdAt: 1 },
    { id: "b", title: "Beta", url: "https://b.example/", status: "error", history: [], tagIds: ["t"], createdAt: 2 },
    { id: "c", title: "Gamma", url: "https://c.example/", status: "error", history: [], tagIds: [], trashedAt: 3, createdAt: 3 },
    { id: "d", title: "Delta", url: "https://d.example/", status: "ok", history: [{ read: true }], tagIds: [], createdAt: 4 }
  ];
  const ids = (view, extra = {}) => visibleMonitorsForView(items, { view, ...extra }).map(item => item.id);
  assert.deepEqual(ids("all"), ["d", "b", "a"]);
  assert.deepEqual(ids("unread"), ["a"]);
  assert.deepEqual(ids("unread", { recentlyRead: new Set(["d"]) }), ["d", "a"]);
  assert.deepEqual(ids("error"), ["b"]);
  assert.deepEqual(ids("trash"), ["c"]);
  assert.deepEqual(ids("tag", { selectedTag: "t" }), ["b", "a"]);
  assert.deepEqual(ids("all", { query: "Beta" }), ["b"]);
});

test("open all continues after a failed tab and only marks opened unread links", async () => {
  const items = [
    { id: "a", url: "https://a.example/", history: [{ read: false }] },
    { id: "b", url: "https://b.example/", history: [{ read: false }] },
    { id: "c", url: "https://c.example/", history: [{ read: true }] }
  ];
  const opened = [], read = [], faded = [];
  const result = await openMonitorLinks(items, {
    async createTab(url) {
      if (url.includes("b.example")) throw new Error("blocked");
      opened.push(url);
    },
    async markRead(id) { read.push(id); },
    onOpened(item) { faded.push(item.id); }
  });
  assert.deepEqual(opened, ["https://a.example/", "https://c.example/"]);
  assert.deepEqual(read, ["a"]);
  assert.deepEqual(faded, ["a", "c"]);
  assert.deepEqual(result, { opened: 2, failed: 1, readFailed: 0 });
});
