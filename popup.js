const current = document.querySelector("#current");
const message = document.querySelector("#message");
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const valid = tab?.url && /^https?:\/\//.test(tab.url);
current.textContent = valid ? (tab.title || tab.url) : "このページは監視できません";
document.querySelector("#whole").disabled = !valid;
document.querySelector("#pick").disabled = !valid;

async function showExisting() {
  if (!valid) return;
  const response = await chrome.runtime.sendMessage({ type: "list" });
  if (!response?.ok) return;
  const currentUrl = new URL(tab.url); currentUrl.hash = "";
  const matches = response.value.filter(monitor => !monitor.trashedAt && monitor.url === currentUrl.href);
  const section = document.querySelector("#existing");
  section.hidden = !matches.length;
  document.querySelector("#existing-count").textContent = `${matches.length} 件`;
  const items = document.querySelector("#existing-list");
  items.replaceChildren();
  for (const monitor of matches.slice(0, 4)) {
    const row = document.createElement("button");
    row.type = "button"; row.className = "existing-item";
    row.textContent = `${monitor.enabled ? "●" : "○"} ${monitor.title}`;
    row.title = "監視の詳細を開く";
    row.addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html#${monitor.id}`) }));
    items.append(row);
  }
  if (matches.length > 4) {
    const more = document.createElement("p"); more.className = "existing-more";
    more.textContent = `ほか ${matches.length - 4} 件`; items.append(more);
  }
}
showExisting().catch(() => {});

document.querySelector("#whole").addEventListener("click", async () => {
  try {
    const result = await chrome.runtime.sendMessage({ type: "create", monitor: { url: tab.url, title: tab.title } });
    if (!result.ok) throw new Error(result.error);
    message.textContent = "監視に追加しました。最初の確認は約 1 分以内です。";
    await showExisting();
  } catch (error) { message.textContent = error.message; }
});

document.querySelector("#pick").addEventListener("click", async () => {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["extract.js"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["picker.js"] });
    window.close();
  } catch (error) { message.textContent = error.message; }
});

document.querySelector("#dashboard").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") }));
