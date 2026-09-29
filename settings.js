import { makeExportData } from "./lib.js";
import { cleanConcurrency } from "./lib.js";
const banner = document.querySelector("#reload-banner");
const status = document.querySelector("#settings-status");
const checkMode = document.querySelector("#check-mode");
const concurrency = document.querySelector("#scan-concurrency");
function stale() {
  banner.hidden = false;
  status.textContent = "拡張機能を再読み込みしてください。";
}
async function send(type, payload = {}) {
  let result;
  try { result = await chrome.runtime.sendMessage({ type, ...payload }); }
  catch (error) { throw error; }
  if (!result?.ok) {
    if (result?.error === "不明な操作です") stale();
    throw new Error(result?.error === "不明な操作です" ? "拡張機能の再読み込みが必要です" : result?.error || "操作に失敗しました");
  }
  return result.value;
}
async function load() {
  try {
    const capabilities = await send("getCapabilities");
    if (capabilities?.protocol !== 3) { stale(); return; }
    checkMode.value = await send("getCheckMode");
    concurrency.value = await send("getScanConcurrency");
  } catch (error) { if (!banner.hidden) return; status.textContent = error.message; }
}
checkMode.addEventListener("change", async () => {
  try { checkMode.value = await send("setCheckMode", { mode: checkMode.value }); status.textContent = "保存しました"; }
  catch (error) { status.textContent = error.message; if (banner.hidden) await load(); }
});
concurrency.addEventListener("change", async () => {
  try {
    const count = cleanConcurrency(concurrency.value);
    concurrency.value = await send("setScanConcurrency", { count });
    status.textContent = "保存しました";
  } catch (error) { status.textContent = error.message; if (banner.hidden) await load(); }
});
document.querySelector("#reload-extension").addEventListener("click", () => chrome.runtime.reload());
document.querySelector("#export").addEventListener("click", async () => {
  try {
    const [monitors, tags] = await Promise.all([send("list"), send("listTags")]);
    const blob = new Blob([JSON.stringify(makeExportData(monitors, tags), null, 2)], { type: "application/json" });
    const anchor = document.createElement("a"); anchor.href = URL.createObjectURL(blob);
    anchor.download = "open-web-monitor-"+new Date().toISOString().slice(0,10)+".json";
    anchor.click(); setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
  } catch (error) { document.querySelector("#import-status").textContent = error.message; }
});
document.querySelector("#import").addEventListener("change", async event => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const count = await send("import", { items: payload });
    document.querySelector("#import-status").textContent = count+" 件を追加しました";
  } catch (error) { document.querySelector("#import-status").textContent = error.message; }
  event.target.value = "";
});
load();