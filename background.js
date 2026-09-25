import { cleanUrl, cleanInterval, cleanIgnoreSelectors, normalizeText, difference, monitorKey, isMonitorKey, MAX_HISTORY } from "./lib.js";

const ALARM = "scan-due-monitors";
const CHECK_MODE_KEY = "checkMode";
const CHECK_MODES = new Set(["pinned-tab", "window"]);
const running = new Set();
let scanInProgress = false;

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

async function createMonitor(input) {
  const url = cleanUrl(input.url);
  const selector = String(input.selector || "").trim();
  if (selector.length > 500) throw new Error("CSS セレクターが長すぎます");
  const ignoreSelectors = cleanIgnoreSelectors(input.ignoreSelectors);
  const monitor = {
    id: crypto.randomUUID(), url, title: String(input.title || new URL(url).hostname).trim().slice(0, 120), autoTitle: Boolean(input.autoTitle),
    selector, ignoreSelectors, intervalMinutes: cleanInterval(input.intervalMinutes ?? 15), enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    createdAt: Date.now(), nextCheckAt: Date.now(), lastCheckAt: null,
    status: "new", error: null, text: null, history: []
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
    const result = await chrome.scripting.executeScript({ target: { tabId }, func: (include, ignore) => globalThis.__openWebMonitorExtract(include, ignore), args: [selector, ignoreSelectors || []] });
    if (result[0]?.error) throw new Error(result[0].error.message);
    if (!result[0]?.result) throw new Error("ページの内容を取得できませんでした");
    return result[0].result;
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
  const count = (await allMonitors()).reduce((sum, item) => sum + (item.history || []).filter(entry => !entry.read).length, 0);
  await chrome.action.setBadgeText({ text: count ? (count > 99 ? "99+" : String(count)) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#dc554c" });
}

async function checkMonitor(id) {
  if (running.has(id)) return;
  running.add(id);
  try {
    const monitor = await getMonitor(id);
    if (!monitor) return;
    const checkedAt = Date.now();
    try {
      const page = await loadInTab(monitor.url, monitor.selector, monitor.ignoreSelectors);
      const text = normalizeText(page.text);
      const latest = await getMonitor(id);
      if (!latest) return;
      if (!sameSelection(monitor, latest)) return;
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
      if (notificationMessage) {
        try {
          await chrome.notifications.create(`change:${id}:${Date.now()}`, {
            type: "basic", iconUrl: "icons/icon128.png", title: `${latest.title} に変更があります`,
            message: notificationMessage
          });
        } catch { /* The change remains in history even if system notifications are unavailable. */ }
      }
    } catch (error) {
      const latest = await getMonitor(id);
      if (!latest) return;
      if (!sameSelection(monitor, latest)) return;
      latest.status = "error";
      latest.error = error?.message || String(error);
      latest.lastCheckAt = checkedAt;
      latest.nextCheckAt = Date.now() + Math.max(latest.intervalMinutes, 5) * 60000;
      await saveMonitor(latest);
    }
    await updateBadge();
  } finally { running.delete(id); }
}

async function scanDue() {
  if (scanInProgress) return;
  scanInProgress = true;
  try {
    const due = (await allMonitors()).filter(m => m.enabled && m.nextCheckAt <= Date.now()).sort((a, b) => a.nextCheckAt - b.nextCheckAt);
    // Bound each alarm run; remaining monitors stay due for the next minute.
    for (let i = 0; i < Math.min(due.length, 24); i += 4) {
      await Promise.allSettled(due.slice(i, i + 4).map(m => checkMonitor(m.id)));
    }
  } finally { scanInProgress = false; }
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); updateBadge(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); updateBadge(); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) scanDue(); });
chrome.notifications.onClicked.addListener(id => {
  const monitorId = id.split(":")[1];
  chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html#${monitorId}`) });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "list": return await allMonitors();
      case "getCheckMode": return await getCheckMode();
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
          enabled: original.enabled
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
            status: "new", error: null, text: null, history: []
          };
          entries[monitorKey(monitor.id)] = monitor;
        }
        await chrome.storage.local.set(entries);
        await ensureAlarm();
        return { created: accepted.length, skipped };
      }
      case "openPicker": return await openPickerForMonitor(message.id);
      case "pickerNavigate": {
        const draft = message.draft || {};
        if (draft.id && !await getMonitor(draft.id)) throw new Error("監視が見つかりません");
        return await openPickerAt(message.url, {
          id: draft.id || null,
          selector: String(draft.selector || "").slice(0, 500),
          ignoreSelectors: cleanIgnoreSelectors(draft.ignoreSelectors)
        });
      }
      case "check": await checkMonitor(message.id); return await getMonitor(message.id);
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
        const selectionChanged = monitor.url !== oldUrl || monitor.selector !== oldSelector || JSON.stringify(monitor.ignoreSelectors || []) !== oldIgnore;
        if (selectionChanged) {
          monitor.text = null; monitor.status = "new";
        }
        if (selectionChanged || monitor.intervalMinutes !== oldInterval || (!wasEnabled && monitor.enabled)) monitor.nextCheckAt = Date.now();
        return await saveMonitor(monitor);
      }
      case "delete": await chrome.storage.local.remove(monitorKey(message.id)); await updateBadge(); return true;
      case "markRead": {
        const monitor = await getMonitor(message.id);
        if (!monitor) return false;
        monitor.history = monitor.history.map(entry => ({ ...entry, read: true }));
        await saveMonitor(monitor); await updateBadge(); return true;
      }
      case "import": {
        if (!Array.isArray(message.items)) throw new Error("JSON 配列が必要です");
        // Validate the whole file before writing any monitor.
        for (const item of message.items) {
          cleanUrl(item.url);
          cleanInterval(item.intervalMinutes ?? 15);
          if (String(item.selector || "").length > 500) throw new Error("CSS セレクターが長すぎます");
          cleanIgnoreSelectors(item.ignoreSelectors);
        }
        let count = 0;
        for (const item of message.items) { await createMonitor(item); count++; }
        return count;
      }
      default: throw new Error("不明な操作です");
    }
  })().then(value => sendResponse({ ok: true, value })).catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
