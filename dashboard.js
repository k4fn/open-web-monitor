import { cleanUrl, intervalParts, intervalFromParts, intervalLabel } from "./lib.js";

const list = document.querySelector("#list");
const search = document.querySelector("#search");
const sort = document.querySelector("#sort");
const editDialog = document.querySelector("#edit-dialog");
const bulkDialog = document.querySelector("#bulk-dialog");
const bulkUrls = document.querySelector("#bulk-urls");
const bulkPreview = document.querySelector("#bulk-preview");
const bulkSubmit = document.querySelector("#bulk-submit");
let monitors = [];
let tags = [];
let view = new URLSearchParams(location.search).get("view") || "all";
let selectedTag = new URLSearchParams(location.search).get("tag");
const recentlyRead = new Set();
let toastTimer;
let pendingRefresh = false;
let refreshTimer;
let bulkPreviewTimer;
let bulkPreviewVersion = 0;

function bulkLines() { return bulkUrls.value.split(/\r?\n/); }

async function updateBulkPreview() {
  const version = ++bulkPreviewVersion;
  const urls = bulkLines();
  if (!urls.some(line => line.trim())) {
    bulkPreview.textContent = "URLを入力してください";
    bulkPreview.classList.remove("error"); bulkSubmit.disabled = true; return;
  }
  try {
    const result = await send("previewBulkDuplicate", { id: bulkDialog.dataset.id, urls });
    if (version !== bulkPreviewVersion) return;
    bulkPreview.textContent = `${result.count} 件を登録 · ${result.skipped} 件をスキップ`;
    bulkPreview.classList.remove("error"); bulkSubmit.disabled = result.count === 0;
  } catch (error) {
    if (version !== bulkPreviewVersion) return;
    bulkPreview.textContent = error.message;
    bulkPreview.classList.add("error"); bulkSubmit.disabled = true;
  }
}

function showToast(message, error = false) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
}

async function send(type, payload = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...payload });
  if (!result?.ok) throw new Error(result?.error || "操作に失敗しました");
  return result.value;
}

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function button(label, action, id, className = "small-button") {
  const node = el("button", className, label);
  node.type = "button";
  node.dataset.action = action;
  node.dataset.id = id;
  return node;
}

function dateText(value) { return value ? new Date(value).toLocaleString("ja-JP") : "未確認"; }
function shortDateText(value) {
  if (!value) return "未確認";
  const date = new Date(value);
  const time = date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function editField(labelText, name, value, type = "text", className = "") {
  const label = el("label", className);
  label.append(el("span", "field-label", labelText));
  const input = el("input");
  input.name = name; input.type = type; input.value = value;
  label.append(input);
  return label;
}

function renderDetail(monitor) {
  const detail = el("div", "detail");
  const form = el("form", "edit-form");
  form.dataset.id = monitor.id;
  const head = el("div", "edit-head");
  const headCopy = el("div");
  headCopy.append(el("h3", "", "監視の設定"), el("p", "", "監視先と確認間隔を編集します。要素はページ上でも選び直せます。"));
  const headActions = el("div", "edit-head-actions");
  const close = button("✕", "closeEdit", monitor.id, "small-button edit-close");
  close.setAttribute("aria-label", "編集画面を閉じる");
  headActions.append(button("ページで要素を選び直す ↗", "openPicker", monitor.id, "secondary"), close);
  head.append(headCopy, headActions);
  form.append(head);

  const basics = el("div", "edit-section");
  basics.append(el("h4", "", "基本情報"));
  const basicsGrid = el("div", "edit-basics-grid");
  basicsGrid.append(editField("名前", "title", monitor.title), editField("監視する URL", "url", decodeURI(monitor.url), "url", "url-edit"));
  basics.append(basicsGrid);
  form.append(basics);

  const ruleGrid = el("div", "edit-rules-grid");
  const target = el("section", "edit-section");
  target.append(el("h4", "", "監視する要素"), el("p", "section-hint", "CSS セレクターを指定します。空欄ならページ全体を監視します。"));
  target.append(editField("CSS セレクター", "selector", monitor.selector, "text", "selector-edit"));
  ruleGrid.append(target);
  const ignore = el("section", "edit-section");
  ignore.append(el("h4", "", "無視する要素"), el("p", "section-hint", "監視範囲から除く CSS セレクターを、1 行に 1 つ入力します。"));
  const ignoreLabel = el("label", "ignore-edit");
  ignoreLabel.append(el("span", "field-label", "除外する CSS セレクター"));
  const ignoreInput = el("textarea"); ignoreInput.name = "ignoreSelectors";
  ignoreInput.rows = 4; ignoreInput.value = (monitor.ignoreSelectors || []).join("\n");
  ignoreInput.placeholder = ".advertisement\narticle header";
  ignoreLabel.append(ignoreInput); ignore.append(ignoreLabel); ruleGrid.append(ignore);
  form.append(ruleGrid);

  const tagSection = el("section", "edit-section");
  tagSection.append(el("h4", "", "タグ"));
  const tagChoices = el("div", "tag-choices");
  for (const tag of tags) {
    const label = el("label", "tag-choice");
    const checkbox = el("input"); checkbox.type = "checkbox"; checkbox.name = "tagIds"; checkbox.value = tag.id;
    checkbox.checked = (monitor.tagIds || []).includes(tag.id);
    label.append(checkbox, el("span", "", tag.name)); tagChoices.append(label);
  }
  tagSection.append(tagChoices); form.append(tagSection);
  const schedule = el("section", "edit-section schedule-section");
  schedule.append(el("h4", "", "確認間隔"), el("p", "section-hint", "1 分〜7 日。Chrome が起動中に確認します。"));
  const interval = el("div", "interval-editor");
  const parts = intervalParts(monitor.intervalMinutes);
  const amountLabel = editField("間隔", "intervalValue", parts.value, "number");
  const amount = amountLabel.querySelector("input"); amount.min = "1"; amount.step = "1"; amount.required = true;
  const unitLabel = el("label"); unitLabel.append(el("span", "field-label", "単位"));
  const unit = el("select"); unit.name = "intervalUnit";
  for (const [value, text] of [["minute", "分"], ["hour", "時間"], ["day", "日"]]) {
    const option = el("option", "", text); option.value = value; option.selected = value === parts.unit; unit.append(option);
  }
  unitLabel.append(unit); interval.append(amountLabel, unitLabel);
  schedule.append(interval);
  const presets = el("div", "interval-presets");
  presets.append(el("span", "", "よく使う間隔"));
  for (const [minutes, text] of [[15, "15 分"], [60, "1 時間"], [360, "6 時間"], [1440, "1 日"], [10080, "7 日"]]) {
    const preset = button(text, "intervalPreset", monitor.id, "preset-button"); preset.dataset.minutes = minutes; presets.append(preset);
  }
  schedule.append(presets); form.append(schedule);

  const footer = el("div", "edit-footer");
  const save = button("変更を保存", "save", monitor.id, "primary");
  save.type = "submit";
  footer.append(save, button("この監視を複製", "duplicate", monitor.id, "secondary"), button("複数URLに複製", "bulkDuplicate", monitor.id, "secondary"), button("ごみ箱へ移動", "delete", monitor.id, "small-button danger"));
  form.append(footer); detail.append(form);
  if (monitor.error) detail.append(el("p", "error-note", `前回のエラー: ${monitor.error}`));
  detail.append(el("h3", "history-title", "変更履歴"));
  if (!monitor.history?.length) detail.append(el("p", "empty-history", "まだ変更は記録されていません。"));
  for (const entry of monitor.history || []) {
    const item = el("article", `history-item${entry.read ? "" : " new"}`);
    item.append(el("time", "", dateText(entry.at)));
    const removed = el("div", "diff-removed"); removed.append(el("span", "diff-label", "変更前"), el("p", "", entry.before || "（空）"));
    const added = el("div", "diff-added"); added.append(el("span", "diff-label", "変更後"), el("p", "", entry.after || "（空）"));
    item.append(removed, added); detail.append(item);
  }
  return detail;
}

function renderNavigation() {
  const active = monitors.filter(m => !m.trashedAt);
  const counts = { all: active.length, unread: active.filter(m => m.history?.some(h => !h.read)).length,
    error: active.filter(m => m.status === "error").length, trash: monitors.length - active.length };
  for (const name of ["all", "unread", "error", "trash"]) {
    document.querySelector("#count-"+name).textContent = counts[name] || "";
    document.querySelector('[data-view="'+name+'"]').classList.toggle("active", view === name);
  }
  const nav = document.querySelector("#tag-nav"); nav.replaceChildren();
  for (const tag of tags) {
    const row = el("div", "tag-nav-row");
    const item = button(tag.name, "viewTag", tag.id, "nav-item"+(view === "tag" && selectedTag === tag.id ? " active" : ""));
    item.append(el("span", "nav-count", active.filter(m => m.tagIds?.includes(tag.id)).length || ""));
    row.append(item, button("⋯", "tagMenu", tag.id, "tag-menu-button")); nav.append(row);
  }
  const title = view === "tag" ? tags.find(t => t.id === selectedTag)?.name || "タグ" :
    ({ all: "すべて", unread: "未読", error: "エラー", trash: "ごみ箱" })[view] || "すべて";
  document.querySelector("#view-title").textContent = title;
  document.querySelector("#view-description").textContent =
    ({ all:"登録中の監視を一覧で確認できます", unread:"変更を確認していない監視", error:"直近の確認でエラーが発生した監視", trash:"復元するまで確認されません" })[view] || "タグを付けた監視";
  const batch = document.querySelector("#batch-check"); batch.hidden = !["all", "error"].includes(view);
  batch.textContent = view === "error" ? "エラーのみ確認" : "全て確認";
  document.querySelector("#add-panel").hidden = view === "trash";
  document.querySelector("#total").textContent = active.length;
  document.querySelector("#unread").textContent = counts.unread;
}

function render() {
  renderNavigation();
  const query = search.value.trim().toLowerCase();
  const visible = monitors.filter(m => {
    if (!(m.title+" "+m.url+" "+(m.text || "")).toLowerCase().includes(query)) return false;
    if (view === "trash") return Boolean(m.trashedAt);
    if (m.trashedAt) return false;
    if (view === "unread") return m.history?.some(h => !h.read) || recentlyRead.has(m.id);
    if (view === "error") return m.status === "error";
    if (view === "tag") return m.tagIds?.includes(selectedTag);
    return true;
  }).sort((a,b) => {
    if (sort.value === "name") return a.title.localeCompare(b.title, "ja");
    if (sort.value === "checked") return (b.lastCheckAt || 0) - (a.lastCheckAt || 0);
    return (b.history?.[0]?.at || b.createdAt) - (a.history?.[0]?.at || a.createdAt);
  });
  document.querySelector("#visible-count").textContent = visible.length+" 件";
  list.replaceChildren();
  if (!visible.length) { list.append(el("div", "empty", "ここに表示する監視はありません")); return; }
  for (const monitor of visible) {
    const unread = (monitor.history || []).filter(h => !h.read).length;
    const faded = view === "unread" && recentlyRead.has(monitor.id) && !unread;
    const card = el("article", "monitor-card"+(unread ? " has-unread" : "")+(faded ? " recently-read" : ""));
    const main = el("div", "monitor-main"), left = el("div", "monitor-info");
    const link = el("a", "title-link", monitor.title || new URL(monitor.url).hostname);
    link.href = monitor.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.dataset.monitorId = monitor.id;
    left.append(link);
    const tagNames = tags.filter(t => monitor.tagIds?.includes(t.id)).map(t => t.name);
    left.append(el("div", "meta", new URL(monitor.url).hostname+(monitor.selector ? " · 部分" : " · 全体")+(tagNames.length ? " · "+tagNames.join(", ") : "")));
    const summary = monitor.status === "error" ? monitor.error : monitor.text === null ? "初回の確認待ち" : monitor.text || "（空のテキスト）";
    const excerpt = el("div", "excerpt", String(summary || "").slice(0,260)); excerpt.title = String(summary || "").slice(0,1000);
    const changes = el("div", "change-count", unread ? unread+" 件" : "—");
    const checked = el("div", "checked", shortDateText(monitor.lastCheckAt));
    const interval = el("div", "interval", intervalLabel(monitor.intervalMinutes));
    const actions = el("div", "monitor-actions");
    if (view === "trash") {
      actions.append(el("span", "status paused", "ごみ箱"), button("復元","restore",monitor.id,"row-button"), button("完全削除","deletePermanently",monitor.id,"row-button danger"));
    } else {
      actions.append(el("span", "status "+(!monitor.enabled ? "paused" : monitor.status), !monitor.enabled ? "停止中" : monitor.status === "error" ? "エラー" : monitor.status === "new" ? "初回待ち" : "稼働中"));
      actions.append(button("確認","check",monitor.id,"row-button"),button(monitor.enabled ? "停止" : "再開","toggle",monitor.id,"row-button"),button("複製","duplicate",monitor.id,"row-button"),button("編集","edit",monitor.id,"row-button"));
    }
    main.append(left, excerpt, changes, checked, interval, actions); card.append(main); list.append(card);
  }
}

async function openEditor(id) {
  let monitor = monitors.find(item => item.id === id);
  if (!monitor) return;
  if (monitor.history?.some(entry => !entry.read)) {
    await send("markRead", { id });
    await refresh();
    monitor = monitors.find(item => item.id === id);
    if (!monitor) return;
  }
  if (editDialog.open) editDialog.close();
  editDialog.replaceChildren(renderDetail(monitor));
  editDialog.showModal();
}

async function refresh() {
  [monitors, tags] = await Promise.all([send("list"), send("listTags")]);
  for (const id of recentlyRead) if (monitors.find(m => m.id === id)?.history?.some(h => !h.read)) recentlyRead.delete(id);
  render(); refreshBatchProgress().catch(() => {});

}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (document.activeElement?.closest(".edit-form")) { pendingRefresh = true; return; }
    refresh().catch(error => showToast(error.message, true));
  }, 120);
}

document.querySelector("#add-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.querySelector("#form-message");
  const data = Object.fromEntries(new FormData(form));
  try {
    data.url = cleanUrl(data.url);
    await send("create", { monitor: data });
    form.reset(); message.textContent = "追加しました。"; showToast("監視を追加しました"); await refresh();
  } catch (error) { message.textContent = error.message; }
});

editDialog.addEventListener("submit", async event => {
  if (!event.target.matches(".edit-form")) return;
  event.preventDefault();
  try {
    const patch = Object.fromEntries(new FormData(event.target));
    patch.tagIds = [...event.target.querySelectorAll('input[name="tagIds"]:checked')].map(input => input.value);
    patch.intervalMinutes = intervalFromParts(patch.intervalValue, patch.intervalUnit);
    delete patch.intervalValue; delete patch.intervalUnit;
    patch.url = cleanUrl(patch.url);
    await send("update", { id: event.target.dataset.id, patch });
    editDialog.close();
    await refresh(); showToast("設定を保存しました");
  } catch (error) { showToast(error.message, true); }
});

document.addEventListener("click", async event => {
  const link = event.target.closest("a[data-monitor-id]");
  if (link && view === "unread") {
    const id = link.dataset.monitorId; recentlyRead.add(id);
    send("markRead", { id }).then(refresh).catch(error => showToast(error.message, true));
    link.closest(".monitor-card")?.classList.add("recently-read"); return;
  }
  const target = event.target.closest("button[data-action]");
  if (!target) return;
  const { action, id } = target.dataset;
  if (action === "viewTag") { navigate("tag", id); return; }
  if (action === "tagMenu") {
    const tag = tags.find(item => item.id === id); if (!tag) return;
    const name = prompt("タグ名を変更します。空欄にすると削除を確認します。", tag.name);
    if (name === null) return;
    try {
      if (name.trim()) await send("renameTag", { id, name });
      else if (confirm("「"+tag.name+"」を削除しますか？監視は残ります。")) await send("deleteTag", { id });
      await refresh();
    } catch (error) { showToast(error.message, true); } return;
  }
  const monitor = monitors.find(item => item.id === id);
  if (!monitor) return;
  try {
    if (action === "intervalPreset") {
      const { value, unit } = intervalParts(Number(target.dataset.minutes));
      const form = target.closest(".edit-form");
      form.elements.intervalValue.value = value;
      form.elements.intervalUnit.value = unit;
      for (const preset of form.querySelectorAll('[data-action="intervalPreset"]')) preset.classList.toggle("selected", preset === target);
      return;
    }
    if (action === "edit") {
      await openEditor(id);
    } else if (action === "closeEdit") {
      editDialog.close();
    } else if (action === "toggle") {
      await send("update", { id, patch: { enabled: !monitor.enabled } }); await refresh();
    } else if (action === "check") {
      target.disabled = true; target.textContent = "…";
      const checked = await send("check", { id }); await refresh();
      showToast(checked.status === "error" ? checked.error : "確認が完了しました", checked.status === "error");
    } else if (action === "openPicker") {
      target.disabled = true; target.textContent = "ページを開いています…";
      await send("openPicker", { id });
      editDialog.close();
      showToast("開いたページで要素を選び直してください");
    } else if (action === "duplicate") {
      const copy = await send("duplicate", { id });
      if (editDialog.open) editDialog.close();
      await refresh();
      await openEditor(copy.id);
      showToast("監視を複製しました");
    } else if (action === "bulkDuplicate") {
      if (editDialog.open) editDialog.close();
      bulkDialog.dataset.id = id;
      document.querySelector("#bulk-source").textContent = `元の監視: ${monitor.title}`;
      bulkUrls.value = "";
      updateBulkPreview();
      bulkDialog.showModal();
      bulkUrls.focus();
    } else if (action === "delete") {
      if (!confirm("「"+monitor.title+"」をごみ箱へ移動しますか？")) return;
      await send("delete", { id }); if (editDialog.open) editDialog.close(); await refresh();
    } else if (action === "restore") {
      await send("restore", { id }); await refresh();
    } else if (action === "deletePermanently") {
      if (!confirm("「"+monitor.title+"」を完全に削除しますか？元に戻せません。")) return;
      await send("deletePermanently", { id }); await refresh();
    }
  } catch (error) { showToast(error.message, true); await refresh(); }
});

bulkUrls.addEventListener("input", () => {
  clearTimeout(bulkPreviewTimer);
  bulkPreviewTimer = setTimeout(updateBulkPreview, 250);
});
document.querySelector("#bulk-close").addEventListener("click", () => bulkDialog.close());
document.querySelector("#bulk-cancel").addEventListener("click", () => bulkDialog.close());
document.querySelector("#bulk-form").addEventListener("submit", async event => {
  event.preventDefault();
  bulkSubmit.disabled = true;
  try {
    const result = await send("bulkDuplicate", { id: bulkDialog.dataset.id, urls: bulkLines() });
    bulkDialog.close();
    await refresh();
    showToast(`${result.created} 件を登録、${result.skipped} 件をスキップしました`);
  } catch (error) {
    bulkPreview.textContent = error.message;
    bulkPreview.classList.add("error");
    bulkSubmit.disabled = false;
  }
});

function navigate(next, tagId = null) {
  view = next; selectedTag = tagId;
  const params = new URLSearchParams();
  if (view !== "all") params.set("view", view);
  if (tagId) params.set("tag", tagId);
  history.pushState(null, "", location.pathname+(params.size ? "?"+params : ""));
  render();
}
document.querySelectorAll(".sidebar [data-view]").forEach(button => button.addEventListener("click", () => navigate(button.dataset.view)));
document.querySelector("#add-tag").addEventListener("click", async () => {
  const name = prompt("新しいタグ名"); if (!name?.trim()) return;
  try { const tag = await send("createTag", { name }); await refresh(); navigate("tag", tag.id); }
  catch (error) { showToast(error.message, true); }
});
window.addEventListener("popstate", () => {
  const params = new URLSearchParams(location.search);
  view = params.get("view") || "all"; selectedTag = params.get("tag"); render();
});
async function refreshBatchProgress() {
  const job = await send("getBatchJob");
  const node = document.querySelector("#batch-progress");
  if (!job) { node.textContent = ""; return; }
  const label = job.scope === "error" ? "エラーのみ確認" : "全て確認";
  node.textContent = label+": "+job.done+"/"+job.ids.length+" 件完了 · 失敗 "+job.failed+" 件"+(job.status === "running" ? "（実行中）" : "");
  document.querySelector("#batch-check").disabled = job.status === "running";
}
document.querySelector("#batch-check").addEventListener("click", async () => {
  try { await send("startBatch", { scope: view === "error" ? "error" : "all" }); await refreshBatchProgress(); }
  catch (error) { showToast(error.message, true); }
});
search.addEventListener("input", render);
sort.addEventListener("change", render);
chrome.storage.onChanged.addListener((_changes, area) => { if (area === "local") scheduleRefresh(); });
editDialog.addEventListener("focusout", () => setTimeout(() => {
  if (pendingRefresh && !document.activeElement?.closest(".edit-form")) { pendingRefresh = false; scheduleRefresh(); }
},0));
editDialog.addEventListener("close", () => { if (pendingRefresh) { pendingRefresh = false; scheduleRefresh(); } });
refresh().then(() => {
  if (location.hash.length > 1) openEditor(decodeURIComponent(location.hash.slice(1))).catch(error => showToast(error.message, true));
}).catch(error => { list.textContent = error.message; });
