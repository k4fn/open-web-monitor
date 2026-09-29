import { cleanUrl, cleanInterval, cleanConcurrency, runWithConcurrency, cleanIgnoreSelectors, normalizeText, difference, monitorKey, isMonitorKey, MAX_HISTORY } from "./lib.js";

const ALARM = "scan-due-monitors";
const CHECK_MODE_KEY = "checkMode";
const SCAN_CONCURRENCY_KEY = "scanConcurrency";
const CHECK_MODES = new Set(["pinned-tab", "window"]);
const running = new Map();
const TAGS_KEY = "tags";
const BATCH_KEY = "batchCheckJob";
const PROTOCOL_VERSION = 4;
let scanInProgress = false;
let batchInProgress = false;
let activeChecks = 0;
const checkWaiters = [];
let batchProgressWrite = Promise.resolve();

async function withCheckSlot(task) {
  const limit = await getScanConcurrency();
  if (activeChecks >= limit) await new Promise(resolve => checkWaiters.push(resolve));
  else activeChecks++;
  try { return await task(); }
  finally {
    const next = checkWaiters.shift();
    if (next) next();
    else activeChecks--;
  }
}


async function ensureAlarm() {
  if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

async function allMonitors() {
  const data = await chrome.storage.local.get(null);
  return Object.entries(data).filter(([key]) => isMonitorKey(key)).map(([, value]) => value);
}

async function getMonitor(id) {
  return (await chrome.storage.local.get(monitorKey(id)))[monitorKey(id)];
}

async function saveMonitor(monitor) {
  await chrome.storage.local.set({ [monitorKey(monitor.id)]: monitor });
  return monitor;
}

async function getCheckMode() {
  const value = (await chrome.storage.local.get(CHECK_MODE_KEY))[CHECK_MODE_KEY];
  return CHECK_MODES.has(value) ? value : "pinned-tab";
}

async function getScanConcurrency() {
  const value = (await chrome.storage.local.get(SCAN_CONCURRENCY_KEY))[SCAN_CONCURRENCY_KEY];
  if (value === undefined) return 4;
  try { return cleanConcurrency(value); } catch { return 4; }
}

function cleanTagIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("タグの形式が無効です");
  return [...new Set(value.map(String))];
}

async function getTags() {
  const value = (await chrome.storage.local.get(TAGS_KEY))[TAGS_KEY];
  return Array.isArray(value) ? value : [];
}

async function validTagIds(ids) {
  const clean = cleanTagIds(ids);
  const known = new Set((await getTags()).map(tag => tag.id));
  if (clean.some(id => !known.has(id))) throw new Error("存在しないタグがあります");
  return clean;
}

async function createMonitor(input) {
  const tagIds = await validTagIds(input.tagIds);
  const url = cleanUrl(input.url);
  const selector = String(input.selector || "").trim();
  if (selector.length > 500) throw new Error("CSS セレクターが長すぎます");
  const ignoreSelectors = cleanIgnoreSelectors(input.ignoreSelectors);
  const monitor = {
    id: crypto.randomUUID(), url, title: String(input.title || new URL(url).hostname).trim().slice(0, 120), autoTitle: Boolean(input.autoTitle),
    selector, ignoreSelectors, intervalMinutes: cleanInterval(input.intervalMinutes ?? 15), enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    createdAt: Date.now(), nextCheckAt: Date.now(), lastCheckAt: null,
    status: "new", error: null, text: null, history: [], tagIds, trashedAt: null,
    notificationsEnabled: input.notificationsEnabled !== false
  };
  await saveMonitor(monitor);
  await ensureAlarm();
  return monitor;
}

async function waitForTab(tabId) {
  await new Promise((resolve, reject) => {
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(updated);
        chrome.tabs.onRemoved.removeListener(removed);
        error ? reject(error) : resolve();
      };
      const updated = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
      const removed = (id) => { if (id === tabId) finish(new Error("タブが閉じられました")); };
      const timer = setTimeout(() => finish(new Error("ページの読み込みがタイムアウトしました")), 30000);
      chrome.tabs.onUpdated.addListener(updated);
      chrome.tabs.onRemoved.addListener(removed);
      chrome.tabs.get(tabId).then(current => { if (current.status === "complete") finish(); }).catch(finish);
    });
  await new Promise(resolve => setTimeout(resolve, 1200));
}

async function loadInTab(url, selector, ignoreSelectors) {
  const mode = await getCheckMode();
  let tabId;
  let windowId;
  try {
    if (mode === "window") {
      const checkWindow = await chrome.windows.create({ url, focused: false, type: "normal" });
      if (checkWindow?.id === undefined) throw new Error("監視用ウィンドウを開けませんでした");
      windowId = checkWindow.id;
      tabId = checkWindow.tabs?.[0]?.id ?? (await chrome.tabs.query({ windowId }))[0]?.id;
    } else {
      tabId = (await chrome.tabs.create({ url, active: false, pinned: true })).id;
    }
    if (tabId === undefined) throw new Error("監視用タブを開けませんでした");
    await waitForTab(tabId);
    await chrome.scripting.executeScript({ target: { tabId }, files: ["extract.js"] });
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (include, ignore) => {
        const deadline = Date.now() + 3000;
        while (true) {
          try {
            return { ok: true, page: globalThis.__openWebMonitorExtract(include, ignore) };
          } catch (error) {
            const message = error?.message || String(error);
            if (!message.startsWith("監視対象が見つかりません:") || Date.now() >= deadline) {
              return { ok: false, message };
            }
            await new Promise(resolve => setTimeout(resolve, 250));
          }
        }
      },
      args: [selector, ignoreSelectors || []]
    });
    if (result[0]?.error) throw new Error(result[0].error.message);
    const extraction = result[0]?.result;
    if (!extraction) throw new Error("ページの内容を取得できませんでした");
    if (!extraction.ok) throw new Error(extraction.message || "ページの内容を取得できませんでした");
    return extraction.page;
  } finally {
    if (windowId !== undefined) {
      try { await chrome.windows.remove(windowId); } catch { /* already closed */ }
    } else if (tabId !== undefined) {
      try { await chrome.tabs.remove(tabId); } catch { /* already closed */ }
    }
  }
}

async function prepareBulkDuplicate(id, urls) {
  const source = await getMonitor(id);
  if (!source) throw new Error("複製元の監視が見つかりません");
  if (!Array.isArray(urls)) throw new Error("URL を1行に1件入力してください");
  const existing = new Set((await allMonitors()).map(item => item.url));
  const seen = new Set();
  const accepted = [];
  let skipped = 0;
  for (const [index, raw] of urls.entries()) {
    if (!String(raw).trim()) continue;
    let url;
    try { url = cleanUrl(String(raw).trim()); }
    catch { throw new Error(`${index + 1} 行目の URL が無効です`); }
    if (existing.has(url) || seen.has(url)) skipped++;
    else { seen.add(url); accepted.push(url); }
  }
  return { source, accepted, skipped };
}

async function openPickerAt(url, config) {
  const targetUrl = cleanUrl(url);
  const tab = await chrome.tabs.create({ url: targetUrl, active: true });
  await waitForTab(tab.id);
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["extract.js"] });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: options => { globalThis.__openWebMonitorPickerConfig = options; },
    args: [config]
  });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["picker.js"] });
  return true;
}

async function openPickerForMonitor(id) {
  const monitor = await getMonitor(id);
  if (!monitor) throw new Error("監視が見つかりません");
  return await openPickerAt(monitor.url, { id, selector: monitor.selector, ignoreSelectors: monitor.ignoreSelectors || [] });
}

function sameSelection(a, b) {
  return a.url === b.url && a.selector === b.selector && JSON.stringify(a.ignoreSelectors || []) === JSON.stringify(b.ignoreSelectors || []);
}

function readableUrl(url) {
  try { return decodeURI(url); } catch { return url; }
}

async function updateBadge() {
  const count = (await allMonitors()).filter(item => !item.trashedAt).reduce((sum, item) => sum + (item.history || []).filter(entry => !entry.read).length, 0);
  await chrome.action.setBadgeText({ text: count ? (count > 99 ? "99+" : String(count)) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#dc554c" });
}

async function checkMonitor(id) {
  if (running.has(id)) return running.get(id);
  const promise = withCheckSlot(async () => {
    const monitor = await getMonitor(id);
    if (!monitor || !monitor.enabled || monitor.trashedAt) return monitor;
    const checkedAt = Date.now();
    try {
      const page = await loadInTab(monitor.url, monitor.selector, monitor.ignoreSelectors);
      const text = normalizeText(page.text);
      const latest = await getMonitor(id);
      if (!latest || latest.trashedAt || !sameSelection(monitor, latest)) return latest;
      let notificationMessage = null;
      if (latest.text !== null && latest.text !== text) {
        const delta = difference(latest.text, text);
        latest.history.unshift({ id: crypto.randomUUID(), at: Date.now(), before: delta.before, after: delta.after, read: false });
        latest.history = latest.history.slice(0, MAX_HISTORY);
        notificationMessage = (delta.after || "内容が削除されました").slice(0, 180);
      }
      latest.text = text;
      if (latest.autoTitle && String(page.title || "").trim()) {
        latest.title = String(page.title).trim().slice(0, 120);
        latest.autoTitle = false;
      }
      latest.status = "ok";
      latest.error = null;
      latest.lastCheckAt = checkedAt;
      latest.nextCheckAt = Date.now() + latest.intervalMinutes * 60000;
      await saveMonitor(latest);
      if (notificationMessage && latest.notificationsEnabled !== false) {
        try {
          await chrome.notifications.create(`change:${id}:${Date.now()}`, {
            type: "basic", iconUrl: "icons/icon128.png", title: `${latest.title} に変更があります`,
            message: notificationMessage
          });
        } catch { /* history remains available */ }
      }
    } catch (error) {
      const latest = await getMonitor(id);
      if (!latest || latest.trashedAt || !sameSelection(monitor, latest)) return latest;
      latest.status = "error";
      latest.error = error?.message || String(error);
      latest.lastCheckAt = checkedAt;
      latest.nextCheckAt = Date.now() + Math.max(latest.intervalMinutes, 5) * 60000;
      await saveMonitor(latest);
    }
    await updateBadge();
    return await getMonitor(id);
  });
  running.set(id, promise);
  try { return await promise; } finally { running.delete(id); }
}

async function scanDue() {
  if (scanInProgress) return;
  scanInProgress = true;
  try {
    const due = (await allMonitors()).filter(m => m.enabled && !m.trashedAt && m.nextCheckAt <= Date.now()).sort((a, b) => a.nextCheckAt - b.nextCheckAt);
    const errors = await runWithConcurrency(due, await getScanConcurrency(), monitor => checkMonitor(monitor.id));
    for (const error of errors) console.error("監視の確認に失敗しました", error);
  } finally { scanInProgress = false; }
}

async function getBatchJob() {
  return (await chrome.storage.local.get(BATCH_KEY))[BATCH_KEY] || null;
}

async function resumeBatch() {
  if (batchInProgress) return;
  batchInProgress = true;
  try {
    let job = await getBatchJob();
    if (!job || job.status !== "running") return;
    const pending = job.ids.filter(id => !job.completed[id]);
    await runWithConcurrency(pending, await getScanConcurrency(), async id => {
      const item = await getMonitor(id);
      let failed = false;
      if (item?.enabled && !item.trashedAt) {
        try { failed = (await checkMonitor(id))?.status === "error"; }
        catch { failed = true; }
      }
      batchProgressWrite = batchProgressWrite.catch(() => {}).then(async () => {
        const latest = await getBatchJob();
        if (!latest || latest.id !== job.id || latest.completed[id]) return;
        latest.completed[id] = { failed, at: Date.now() };
        latest.done = Object.keys(latest.completed).length;
        latest.failed = Object.values(latest.completed).filter(value => value.failed).length;
        if (latest.done >= latest.ids.length) latest.status = "done";
        await chrome.storage.local.set({ [BATCH_KEY]: latest });
      });
      await batchProgressWrite;
    });
  } finally { batchInProgress = false; }
}

async function startBatch(scope, requestedIds) {
  if (!["all", "error", "selected"].includes(scope)) throw new Error("一括確認の対象が無効です");
  const current = await getBatchJob();
  if (current?.status === "running") return current;
  let selected = null;
  if (scope === "selected") {
    if (!Array.isArray(requestedIds) || !requestedIds.length || requestedIds.some(id => typeof id !== "string") || new Set(requestedIds).size !== requestedIds.length) throw new Error("確認対象を選択してください");
    selected = new Set(requestedIds);
  }
  const items = (await allMonitors()).filter(item => item.enabled && !item.trashedAt && (scope === "all" || scope === "error" && item.status === "error" || scope === "selected" && selected.has(item.id)));
  const job = { id: crypto.randomUUID(), scope, ids: items.map(item => item.id), completed: {}, done: 0, failed: 0, status: items.length ? "running" : "done", startedAt: Date.now() };
  await chrome.storage.local.set({ [BATCH_KEY]: job });
  if (items.length) resumeBatch().catch(error => console.error("一括確認に失敗しました", error));
  return job;
}

async function saveTags(tags) {
  await chrome.storage.local.set({ [TAGS_KEY]: tags });
  return tags;
}

async function importData(payload) {
  const legacy = Array.isArray(payload);
  const items = legacy ? payload : payload?.monitors;
  const incomingTags = legacy ? [] : payload?.tags;
  if (!Array.isArray(items) || !Array.isArray(incomingTags)) throw new Error("インポート形式が無効です");
  for (const item of items) {
    cleanUrl(item.url); cleanInterval(item.intervalMinutes ?? 15);
    if (String(item.selector || "").length > 500) throw new Error("CSS セレクターが長すぎます");
    cleanIgnoreSelectors(item.ignoreSelectors);
    cleanTagIds(item.tagIds);
  }
  const names = new Set();
  for (const tag of incomingTags) {
    const name = String(tag.name || "").trim();
    if (!name || names.has(name.toLowerCase())) throw new Error("タグ名が無効か重複しています");
    names.add(name.toLowerCase());
  }
  const tags = await getTags();
  const tagMap = new Map();
  for (const tag of incomingTags) {
    let existing = tags.find(item => item.name.toLowerCase() === String(tag.name).trim().toLowerCase());
    if (!existing) { existing = { id: crypto.randomUUID(), name: String(tag.name).trim() }; tags.push(existing); }
    tagMap.set(String(tag.id), existing.id);
  }
  for (const item of items) {
    if ((item.tagIds || []).some(id => !tagMap.has(String(id)))) throw new Error("監視に存在しないタグが含まれています");
  }
  const entries = { [TAGS_KEY]: tags };
  for (const item of items) {
    const url = cleanUrl(item.url);
    const monitor = {
      id: crypto.randomUUID(), url, title: String(item.title || new URL(url).hostname).trim().slice(0, 120),
      autoTitle: Boolean(item.autoTitle), selector: String(item.selector || "").trim(),
      ignoreSelectors: cleanIgnoreSelectors(item.ignoreSelectors), intervalMinutes: cleanInterval(item.intervalMinutes ?? 15),
      enabled: item.enabled === undefined ? true : Boolean(item.enabled), createdAt: Date.now(), nextCheckAt: Date.now(),
      lastCheckAt: null, status: "new", error: null, text: null, history: [],
      tagIds: (item.tagIds || []).map(id => tagMap.get(String(id))), trashedAt: item.trashedAt ? Date.now() : null,
      notificationsEnabled: item.notificationsEnabled !== false
    };
    entries[monitorKey(monitor.id)] = monitor;
  }
  await chrome.storage.local.set(entries);
  await ensureAlarm();
  await updateBadge();
  return items.length;
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); updateBadge(); resumeBatch(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); updateBadge(); resumeBatch(); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) { scanDue(); resumeBatch(); } });
chrome.notifications.onClicked.addListener(notificationId => {
  if (!notificationId.startsWith("change:")) return;
  const monitorId = notificationId.split(":")[1];
  (async () => {
    const monitor = await getMonitor(monitorId);
    if (!monitor) return;
    await chrome.tabs.create({ url: monitor.url, active: true });
    monitor.history = (monitor.history || []).map(entry => ({ ...entry, read: true }));
    await saveMonitor(monitor);
    await updateBadge();
  })().catch(error => console.error("通知から監視先を開けませんでした", error));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "list": return await allMonitors();
      case "getCapabilities": return { protocol: PROTOCOL_VERSION };
      case "listTags": return await getTags();
      case "getBatchJob": return await getBatchJob();
      case "bulkUpdate": {
        const ids = message.ids;
        if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length) {
          throw new Error("編集対象を選択してください");
        }
        const hasInterval = message.intervalMinutes !== undefined;
        const intervalMinutes = hasInterval ? cleanInterval(message.intervalMinutes) : null;
        const tagMode = message.tagMode || "none";
        if (!["none", "add", "remove"].includes(tagMode)) throw new Error("タグ操作が無効です");
        const tagIds = tagMode === "none" ? [] : await validTagIds(message.tagIds);
        if (tagMode !== "none" && !tagIds.length) throw new Error("変更するタグを選択してください");
        const hasNotifications = message.notificationsEnabled !== undefined;
        const hasEnabled = message.enabled !== undefined;
        if (!hasInterval && tagMode === "none" && !hasNotifications && !hasEnabled) throw new Error("変更内容を指定してください");
        const monitors = await Promise.all(ids.map(getMonitor));
        if (monitors.some(item => !item || item.trashedAt)) throw new Error("編集できない監視が含まれています。一覧を更新してください");
        const now = Date.now();
        const entries = {};
        for (const monitor of monitors) {
          if (hasInterval && monitor.intervalMinutes !== intervalMinutes) {
            monitor.intervalMinutes = intervalMinutes;
            monitor.nextCheckAt = now;
          }
          if (tagMode === "add") monitor.tagIds = [...new Set([...(monitor.tagIds || []), ...tagIds])];
          if (tagMode === "remove") monitor.tagIds = (monitor.tagIds || []).filter(id => !tagIds.includes(id));
          if (hasNotifications) monitor.notificationsEnabled = Boolean(message.notificationsEnabled);
          if (hasEnabled && monitor.enabled !== Boolean(message.enabled)) {
            monitor.enabled = Boolean(message.enabled);
            if (monitor.enabled) monitor.nextCheckAt = now;
          }
          entries[monitorKey(monitor.id)] = monitor;
        }
        await chrome.storage.local.set(entries);
        return { updated: monitors.length };
      }
      case "bulkTrash": {
        const ids = message.ids;
        if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length) throw new Error("削除対象を選択してください");
        const monitors = await Promise.all(ids.map(getMonitor));
        if (monitors.some(item => !item || item.trashedAt)) throw new Error("削除できない監視が含まれています。一覧を更新してください");
        const trashedAt = Date.now();
        const entries = Object.fromEntries(monitors.map(monitor => [monitorKey(monitor.id), { ...monitor, trashedAt }]));
        await chrome.storage.local.set(entries);
        await updateBadge();
        return { updated: monitors.length };
      }
      case "bulkRestore": {
        const ids = message.ids;
        if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length) throw new Error("復元対象を選択してください");
        const monitors = await Promise.all(ids.map(getMonitor));
        if (monitors.some(item => !item || !item.trashedAt)) throw new Error("復元できない監視が含まれています。一覧を更新してください");
        const now = Date.now();
        const entries = Object.fromEntries(monitors.map(monitor => {
          monitor.trashedAt = null;
          if (monitor.enabled) monitor.nextCheckAt = now;
          return [monitorKey(monitor.id), monitor];
        }));
        await chrome.storage.local.set(entries);
        return { updated: monitors.length };
      }
      case "bulkDeletePermanently": {
        const ids = message.ids;
        if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length) throw new Error("削除対象を選択してください");
        const monitors = await Promise.all(ids.map(getMonitor));
        if (monitors.some(item => !item || !item.trashedAt)) throw new Error("完全削除できない監視が含まれています。一覧を更新してください");
        for (const id of ids) await chrome.storage.local.remove(monitorKey(id));
        await updateBadge();
        return { deleted: ids.length };
      }
      case "startBatch": return await startBatch(message.scope, message.ids);
      case "createTag": {
        const name = String(message.name || "").trim().slice(0, 80);
        if (!name) throw new Error("タグ名を入力してください");
        const tags = await getTags();
        if (tags.some(tag => tag.name.toLowerCase() === name.toLowerCase())) throw new Error("同じ名前のタグがあります");
        const tag = { id: crypto.randomUUID(), name };
        await saveTags([...tags, tag]);
        return tag;
      }
      case "renameTag": {
        const name = String(message.name || "").trim().slice(0, 80);
        if (!name) throw new Error("タグ名を入力してください");
        const tags = await getTags();
        const tag = tags.find(item => item.id === message.id);
        if (!tag) throw new Error("タグが見つかりません");
        if (tags.some(item => item.id !== tag.id && item.name.toLowerCase() === name.toLowerCase())) throw new Error("同じ名前のタグがあります");
        tag.name = name; await saveTags(tags); return tag;
      }
      case "deleteTag": {
        const tags = await getTags();
        if (!tags.some(item => item.id === message.id)) throw new Error("タグが見つかりません");
        const entries = { [TAGS_KEY]: tags.filter(item => item.id !== message.id) };
        for (const monitor of await allMonitors()) {
          if (monitor.tagIds?.includes(message.id)) {
            monitor.tagIds = monitor.tagIds.filter(id => id !== message.id);
            entries[monitorKey(monitor.id)] = monitor;
          }
        }
        await chrome.storage.local.set(entries); return true;
      }
      case "getCheckMode": return await getCheckMode();
      case "getScanConcurrency": return await getScanConcurrency();
      case "setScanConcurrency": {
        const count = cleanConcurrency(message.count);
        await chrome.storage.local.set({ [SCAN_CONCURRENCY_KEY]: count });
        return count;
      }
      case "setCheckMode": {
        if (!CHECK_MODES.has(message.mode)) throw new Error("監視時の開き方が無効です");
        await chrome.storage.local.set({ [CHECK_MODE_KEY]: message.mode });
        return message.mode;
      }
      case "create": return await createMonitor(message.monitor);
      case "duplicate": {
        const original = await getMonitor(message.id);
        if (!original) throw new Error("複製元の監視が見つかりません");
        const copy = await createMonitor({
          url: original.url,
          title: `${original.title.slice(0, 110)} (コピー)`,
          selector: original.selector,
          ignoreSelectors: original.ignoreSelectors || [],
          intervalMinutes: original.intervalMinutes,
          enabled: original.enabled,
          tagIds: original.tagIds || [],
          notificationsEnabled: original.notificationsEnabled !== false
        });
        return copy;
      }
      case "previewBulkDuplicate": {
        const { accepted, skipped } = await prepareBulkDuplicate(message.id, message.urls);
        return { count: accepted.length, skipped };
      }
      case "bulkDuplicate": {
        const { source, accepted, skipped } = await prepareBulkDuplicate(message.id, message.urls);
        if (!accepted.length) return { created: 0, skipped };
        const entries = {};
        for (const url of accepted) {
          const monitor = {
            id: crypto.randomUUID(), url, title: readableUrl(url).slice(0, 120), autoTitle: true,
            selector: source.selector, ignoreSelectors: [...(source.ignoreSelectors || [])],
            intervalMinutes: source.intervalMinutes, enabled: source.enabled,
            createdAt: Date.now(), nextCheckAt: Date.now(), lastCheckAt: null,
            status: "new", error: null, text: null, history: [], tagIds: [...(source.tagIds || [])], trashedAt: null,
            notificationsEnabled: source.notificationsEnabled !== false
          };
          entries[monitorKey(monitor.id)] = monitor;
        }
        await chrome.storage.local.set(entries);
        await ensureAlarm();
        return { created: accepted.length, skipped };
      }
      case "openPicker": return await openPickerForMonitor(message.id);
      case "openEditor": {
        if (!await getMonitor(message.id)) throw new Error("監視が見つかりません");
        await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html#" + encodeURIComponent(message.id)), active: true });
        return true;
      }
      case "pickerNavigate": {
        const draft = message.draft || {};
        if (draft.id && !await getMonitor(draft.id)) throw new Error("監視が見つかりません");
        return await openPickerAt(message.url, {
          id: draft.id || null,
          selector: String(draft.selector || "").slice(0, 500),
          ignoreSelectors: cleanIgnoreSelectors(draft.ignoreSelectors)
        });
      }
      case "check": return await checkMonitor(message.id);
      case "update": {
        const monitor = await getMonitor(message.id);
        if (!monitor) throw new Error("監視が見つかりません");
        const patch = message.patch || {};
        const oldUrl = monitor.url;
        const oldSelector = monitor.selector;
        const oldIgnore = JSON.stringify(monitor.ignoreSelectors || []);
        const oldInterval = monitor.intervalMinutes;
        const wasEnabled = monitor.enabled;
        if (patch.url !== undefined) monitor.url = cleanUrl(patch.url);
        if (patch.title !== undefined) {
          const title = String(patch.title).trim().slice(0, 120) || new URL(monitor.url).hostname;
          if (title !== monitor.title) monitor.autoTitle = false;
          monitor.title = title;
        }
        if (patch.selector !== undefined) {
          const selector = String(patch.selector).trim();
          if (selector.length > 500) throw new Error("CSS セレクターが長すぎます");
          monitor.selector = selector;
        }
        if (patch.ignoreSelectors !== undefined) monitor.ignoreSelectors = cleanIgnoreSelectors(patch.ignoreSelectors);
        if (patch.intervalMinutes !== undefined) monitor.intervalMinutes = cleanInterval(patch.intervalMinutes);
        if (patch.enabled !== undefined) monitor.enabled = Boolean(patch.enabled);
        if (patch.notificationsEnabled !== undefined) monitor.notificationsEnabled = Boolean(patch.notificationsEnabled);
        if (patch.tagIds !== undefined) monitor.tagIds = await validTagIds(patch.tagIds);
        const selectionChanged = monitor.url !== oldUrl || monitor.selector !== oldSelector || JSON.stringify(monitor.ignoreSelectors || []) !== oldIgnore;
        if (selectionChanged) {
          monitor.text = null; monitor.status = "new";
        }
        if (selectionChanged || monitor.intervalMinutes !== oldInterval || (!wasEnabled && monitor.enabled)) monitor.nextCheckAt = Date.now();
        return await saveMonitor(monitor);
      }
      case "delete": {
        const monitor = await getMonitor(message.id);
        if (!monitor) return false;
        monitor.trashedAt = Date.now(); await saveMonitor(monitor); await updateBadge(); return true;
      }
      case "restore": {
        const monitor = await getMonitor(message.id);
        if (!monitor) return false;
        monitor.trashedAt = null;
        if (monitor.enabled) monitor.nextCheckAt = Date.now();
        await saveMonitor(monitor); await updateBadge(); return true;
      }
      case "deletePermanently": {
        await chrome.storage.local.remove(monitorKey(message.id)); await updateBadge(); return true;
      }
      case "markRead": {
        const monitor = await getMonitor(message.id);
        if (!monitor) return false;
        monitor.history = monitor.history.map(entry => ({ ...entry, read: true }));
        await saveMonitor(monitor); await updateBadge(); return true;
      }
      case "import": return await importData(message.items);
      default: throw new Error("不明な操作です");
    }
  })().then(value => sendResponse({ ok: true, value })).catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
