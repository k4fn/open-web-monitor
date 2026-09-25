(() => {
  if (globalThis.__openWebMonitorPicker) return;
  globalThis.__openWebMonitorPicker = true;
  const config = globalThis.__openWebMonitorPickerConfig || null;
  delete globalThis.__openWebMonitorPickerConfig;
  const include = config?.selector ? [{ value: config.selector, candidates: [] }] : [];
  const ignore = (config?.ignoreSelectors || []).map(value => ({ value, candidates: [] }));
  let mode = "include";
  let hovered = null;
  let oldOutline = "";
  let oldOffset = "";

  const host = document.createElement("div");
  host.id = "open-web-monitor-picker";
  Object.assign(host.style, { position: "fixed", bottom: "0", left: "0", right: "0", zIndex: "2147483647" });
  const shadow = host.attachShadow({ mode: "open" });
  const overlays = document.createElement("div");
  Object.assign(overlays.style, { position: "fixed", inset: "0", zIndex: "2147483646", pointerEvents: "none" });
  overlays.setAttribute("aria-hidden", "true");
  document.documentElement.append(overlays);
  shadow.innerHTML = `
    <style>
      *{box-sizing:border-box}button,input{font:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}
      .panel{font:14px/1.45 system-ui,"Noto Sans JP",sans-serif;color:#e8f2f0;background:#14252b;border-top:3px solid #17b89c;box-shadow:0 -12px 40px #0008;max-height:55vh;min-height:330px;display:flex;flex-direction:column}
      .bar{display:flex;align-items:center;gap:12px;padding:9px 15px;border-bottom:1px solid #34464c}
      .brand{font-weight:750;white-space:nowrap}.hint{font-size:11px;color:#aabec0;flex:1}.mode{border:1px solid #52656a;color:#dce7e7;background:#263b41;border-radius:6px;padding:6px 10px;white-space:nowrap}
      .mode.active.include{background:#087b70;border-color:#17b89c;color:white}.mode.active.ignore{background:#a75b43;border-color:#e58a6b;color:white}
      .save{background:#14a58f;border:0;color:white;border-radius:6px;padding:7px 12px;font-weight:700;white-space:nowrap}.whole{background:#263b41;border:1px solid #52656a;color:#dce7e7;border-radius:6px;padding:6px 9px}.close{border:0;background:none;color:#dbe5e5;font-size:22px;line-height:1}
      .url-row{display:flex;align-items:center;gap:9px;padding:7px 14px;border-bottom:1px solid #34464c}.url-row label{font-size:11px;font-weight:700;white-space:nowrap}.url-row input{flex:1;min-width:0;background:#20343a;color:#eef6f5;border:1px solid #50676b;border-radius:5px;padding:6px 8px;font:12px ui-monospace,SFMono-Regular,monospace}.url-row button{background:#263b41;border:1px solid #52656a;color:#e8f2f0;border-radius:6px;padding:6px 9px;white-space:nowrap}.url-row small{font-size:10px;color:#adc2c3;min-width:130px}.content{display:grid;grid-template-columns:minmax(300px,1fr) minmax(320px,1fr);gap:0;min-height:0;flex:1}.selection{overflow:auto;padding:11px 14px}.preview-side{border-left:1px solid #34464c;display:flex;flex-direction:column;min-height:0;padding:11px 14px}
      .group{margin-bottom:12px}.group-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;font-weight:700}.group-head em{font-size:11px;color:#9bb1b4;font-style:normal;font-weight:400}.rule{display:flex;gap:6px;align-items:center;margin:4px 0}.rule input,.rule select{background:#263b41;border:1px solid #4b6065;border-radius:5px;color:#eef6f5;padding:7px 8px;min-width:0;font:13px ui-monospace,SFMono-Regular,monospace}.rule input{flex:1}.rule select{width:155px}.rule input:focus,.rule select:focus{outline:2px solid #17b89c;outline-offset:1px}.rule small{min-width:50px;color:#adc3c4;text-align:right}.remove{background:transparent;border:0;color:#e2a79c;font-size:18px;padding:0 5px}.empty{font-size:11px;color:#8fa5a9;margin:4px 0}.preview-head{display:flex;justify-content:space-between;align-items:center;gap:8px;font-weight:700;margin-bottom:7px}.preview-head small{font-weight:400;color:#9bb1b4;margin-left:auto}.preview-head button{background:#263b41;color:#dce7e7;border:1px solid #52656a;border-radius:5px;padding:3px 7px;font-size:11px}.preview{background:#20343a;border:1px solid #435a5e;border-radius:6px;white-space:pre-wrap;overflow:auto;overflow-wrap:anywhere;flex:1;min-height:140px;margin:0;padding:10px;font:13px/1.55 ui-monospace,SFMono-Regular,monospace;color:#eef6f5}.status{font-size:12px;color:#f0bc9f;min-height:22px;padding-top:5px}.legend{display:flex;gap:8px;align-items:center;font-size:11px;color:#b7c9c9}.legend i{display:inline-block;width:10px;height:10px;border:2px solid #17b89c;margin-right:4px}.legend i.red{border-color:#f17668}
      @media(max-width:750px){.panel{max-height:72vh;min-height:320px}.hint{display:none}.content{grid-template-columns:1fr;overflow:auto}.selection{max-height:25vh}.preview-side{border-left:0;border-top:1px solid #34464c;min-height:150px}.bar,.url-row{flex-wrap:wrap}.brand{width:100%}.url-row input{flex:1 0 100%;order:2}.url-row small{display:none}.rule{flex-wrap:wrap}.rule select{width:100%;flex:0 0 100%}}
    </style>
    <div class="panel" role="dialog" aria-label="監視する要素を選択">
      <div class="bar"><span class="brand">◉ 要素セレクター</span><span class="hint">モードを選び、ページ上をクリックして追加</span><span class="legend"><span><i></i>監視</span><span><i class="red"></i>無視</span></span><button class="mode include active" data-mode="include">監視する要素</button><button class="mode ignore" data-mode="ignore">無視する要素</button><button class="whole" title="ページ全体を監視">全体</button><button class="save">選択を保存</button><button class="close" title="閉じる" aria-label="閉じる">×</button></div>
      <div class="url-row"><label for="target-url">監視 URL</label><input id="target-url" type="url" spellcheck="false" aria-label="監視 URL"><button id="open-url">この URL で開く</button><small id="url-note"></small></div>
      <div class="content"><div class="selection"><div class="group"><div class="group-head">監視する要素 <em>複数追加できます</em></div><div id="include-list"></div></div><div class="group"><div class="group-head">無視する要素 <em>監視範囲内から除外</em></div><div id="ignore-list"></div></div></div><div class="preview-side"><div class="preview-head">抽出プレビュー <small id="counts"></small><button id="refresh-preview" title="ページの現在の内容を再取得">↻ 更新</button></div><pre class="preview" id="preview"></pre><div class="status" id="status" role="status"></div></div></div>
    </div>`;
  document.documentElement.append(host);

  const $ = selector => shadow.querySelector(selector);
  const urlField = $("#target-url");
  try { urlField.value = decodeURI(location.href); }
  catch { urlField.value = location.href; }
  function selectedUrl() {
    const url = new URL(urlField.value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("http または https の URL を入力してください");
    url.hash = "";
    return url.href;
  }
  function pageUrl() { const url = new URL(location.href); url.hash = ""; return url.href; }
  function updateUrlNote() {
    try {
      const same = selectedUrl() === pageUrl();
      $("#url-note").textContent = same ? "このページをプレビュー中" : "新 URL を開いて確認してください";
      $("#open-url").disabled = same;
    } catch { $("#url-note").textContent = "URL を確認してください"; $("#open-url").disabled = false; }
  }
  function clearHover() {
    if (hovered) { hovered.style.outline = oldOutline; hovered.style.outlineOffset = oldOffset; hovered = null; }
  }
  function close() {
    clearHover();
    document.removeEventListener("pointerover", onHover, true);
    document.removeEventListener("click", onPick, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", renderOverlays, true);
    window.removeEventListener("resize", renderOverlays);
    host.remove();
    overlays.remove();
    delete globalThis.__openWebMonitorPicker;
  }
  function selectorFor(element) {
    const parts = [];
    for (let current = element; current && current !== document.documentElement; current = current.parentElement) {
      if (current.id) { parts.unshift(`#${CSS.escape(current.id)}`); break; }
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement ? [...current.parentElement.children].filter(child => child.tagName === current.tagName) : [];
      parts.unshift(tag + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ""));
    }
    return parts.join(" > ");
  }
  function selectorCandidates(element) {
    const options = [];
    const seen = new Set();
    const add = (value, label) => {
      if (!value || seen.has(value)) return;
      seen.add(value);
      const count = document.querySelectorAll(value).length;
      options.push({ value, label: `${label} · ${count} 件` });
    };
    const path = selectorFor(element);
    for (let current = element, depth = 0; current && depth < 6; current = current.parentElement, depth++) {
      const prefix = depth ? `親${depth}: ` : "";
      if (current.id) add(`#${CSS.escape(current.id)}`, `${prefix}#${current.id}`);
      const classes = [...current.classList].sort((a, b) => Number(/^js[-_]/i.test(b)) - Number(/^js[-_]/i.test(a)));
      for (const name of classes.slice(0, 4)) add(`.${CSS.escape(name)}`, `${prefix}.${name}`);
      if (depth) add(selectorFor(current), `${prefix}詳細パス`);
    }
    add(path, "クリック位置への詳細パス");
    const jsClass = [...element.classList].find(name => /^js[-_]/i.test(name));
    const initial = jsClass ? `.${CSS.escape(jsClass)}` : element.id ? `#${CSS.escape(element.id)}` : path;
    return { value: initial, candidates: options };
  }
  function renderOverlays() {
    overlays.replaceChildren();
    for (const [rules, color, tint, label] of [[include, "#17b89c", "#17b89c19", "監視"], [ignore, "#f17668", "#f176681c", "無視"]]) {
      let shown = 0;
      for (const rule of rules) {
        if (!rule.value.trim()) continue;
        let elements;
        try { elements = document.querySelectorAll(rule.value); } catch { continue; }
        for (const element of elements) {
          if (element === host || element === overlays || host.contains(element) || overlays.contains(element)) continue;
          const rect = element.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2 || rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) continue;
          const frame = document.createElement("div");
          Object.assign(frame.style, {
            position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
            border: `2px solid ${color}`, background: tint, boxSizing: "border-box", boxShadow: `0 0 0 1px ${color}66`
          });
          if (shown < 10) {
            const tag = document.createElement("span");
            tag.textContent = label;
            Object.assign(tag.style, { position: "absolute", top: "0", left: "0", background: color, color: "white", padding: "1px 4px", font: "bold 10px system-ui,sans-serif" });
            frame.append(tag);
          }
          overlays.append(frame);
          if (++shown >= 200) break;
        }
        if (shown >= 200) break;
      }
    }
  }
  function setMode(next) {
    mode = next;
    for (const button of shadow.querySelectorAll(".mode")) button.classList.toggle("active", button.dataset.mode === mode);
    clearHover();
  }
  function renderRules(kind, rules) {
    const container = $(`#${kind}-list`);
    container.replaceChildren();
    if (!rules.length) {
      const empty = document.createElement("p"); empty.className = "empty";
      empty.textContent = kind === "include" ? "ページ上で監視したい場所をクリックしてください。" : "除外したい場所をクリックしてください。";
      container.append(empty);
    }
    rules.forEach((rule, index) => {
      const row = document.createElement("div"); row.className = "rule";
      const picker = document.createElement("select"); picker.setAttribute("aria-label", "CSS セレクター候補");
      const prompt = document.createElement("option"); prompt.textContent = "CSS 候補"; prompt.value = ""; picker.append(prompt);
      for (const candidate of rule.candidates) {
        const option = document.createElement("option"); option.value = candidate.value; option.textContent = candidate.label; option.title = candidate.label; picker.append(option);
      }
      picker.addEventListener("change", () => { if (picker.value) { rule.value = picker.value; input.value = picker.value; updateCount(); updatePreview(); } });
      const input = document.createElement("input"); input.value = rule.value; input.setAttribute("aria-label", `${kind === "include" ? "監視" : "無視"}セレクター ${index + 1}`);
      input.placeholder = ".js-replyNewMessageContainer などを入力";
      const count = document.createElement("small");
      function updateCount() { try { count.textContent = `${document.querySelectorAll(rule.value).length} 件`; } catch { count.textContent = "無効"; } }
      input.addEventListener("input", () => {
        rule.value = input.value;
        updateCount();
        updatePreview();
      });
      updateCount();
      const remove = document.createElement("button"); remove.className = "remove"; remove.textContent = "×"; remove.title = "削除";
      remove.addEventListener("click", () => { rules.splice(index, 1); render(); });
      row.append(picker, input, count, remove); container.append(row);
    });
  }
  function updatePreview() {
    const preview = $("#preview");
    const counts = $("#counts");
    const status = $("#status");
    status.textContent = "";
    renderOverlays();
    if (!include.length) { preview.textContent = "監視する要素を選択すると、ここに抽出結果を表示します。"; counts.textContent = ""; return; }
    try {
      const result = globalThis.__openWebMonitorExtract(include.map(rule => rule.value.trim()).filter(Boolean).join(", "), ignore.map(rule => rule.value.trim()).filter(Boolean));
      const original = ignore.some(rule => rule.value.trim())
        ? globalThis.__openWebMonitorExtract(include.map(rule => rule.value.trim()).filter(Boolean).join(", "), [])
        : result;
      preview.textContent = result.text.slice(0, 12_000) || "（抽出テキストがありません）";
      counts.textContent = `${result.matchCount} 要素 · ${result.ignoredCount} 除外 · ${result.text.length.toLocaleString()} / ${original.text.length.toLocaleString()} 文字`;
      if (original.text.length > 100 && result.text.length < original.text.length * 0.25) status.textContent = "除外後に元のテキストの 25% 未満しか残っていません。赤枠の範囲を確認してください。";
      else if (result.text.length > 12_000) status.textContent = "プレビューは先頭 12,000 文字を表示しています。";
    } catch (error) { preview.textContent = ""; counts.textContent = ""; status.textContent = error.message; }
  }
  function render() { renderRules("include", include); renderRules("ignore", ignore); updatePreview(); }
  function isPanelEvent(event) { return event.composedPath().includes(host); }
  function onHover(event) {
    if (isPanelEvent(event)) { clearHover(); return; }
    const target = event.target;
    if (!(target instanceof Element) || target === hovered) return;
    clearHover(); hovered = target; oldOutline = target.style.outline; oldOffset = target.style.outlineOffset;
    target.style.outline = `3px solid ${mode === "include" ? "#17b89c" : "#e58a6b"}`;
    target.style.outlineOffset = "2px";
  }
  function onPick(event) {
    if (isPanelEvent(event)) return;
    const target = hovered || event.target;
    if (!(target instanceof Element)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const candidate = selectorCandidates(target);
    clearHover();
    const rules = mode === "include" ? include : ignore;
    if (!rules.some(rule => rule.value === candidate.value)) rules.push(candidate);
    render();
  }
  function onKey(event) { if (event.key === "Escape") close(); }

  shadow.querySelectorAll(".mode").forEach(button => button.addEventListener("click", () => setMode(button.dataset.mode)));
  $(".whole").addEventListener("click", () => { include.splice(0, include.length, { value: "body", candidates: [] }); render(); });
  $("#refresh-preview").addEventListener("click", render);
  if (config?.id) $(".save").textContent = "選択を更新";
  urlField.addEventListener("input", updateUrlNote);
  $("#open-url").addEventListener("click", async () => {
    try {
      const url = selectedUrl();
      if (url === pageUrl()) { $("#status").textContent = "現在のページを表示しています。"; return; }
      const button = $("#open-url"); button.disabled = true;
      const response = await chrome.runtime.sendMessage({
        type: "pickerNavigate", url,
        draft: { id: config?.id || null, selector: include.map(rule => rule.value.trim()).filter(Boolean).join(", "), ignoreSelectors: ignore.map(rule => rule.value.trim()).filter(Boolean) }
      });
      if (!response?.ok) throw new Error(response?.error || "ページを開けませんでした");
      close();
    } catch (error) { $("#status").textContent = error.message; $("#open-url").disabled = false; }
  });
  $(".close").addEventListener("click", close);
  $(".save").addEventListener("click", async () => {
    const selector = include.map(rule => rule.value.trim()).filter(Boolean).join(", ");
    const ignoreSelectors = ignore.map(rule => rule.value.trim()).filter(Boolean);
    if (!selector) { $("#status").textContent = "監視する要素を選択してください。"; return; }
    if (selector.length > 500) { $("#status").textContent = "監視セレクターは 500 文字以内にしてください。"; return; }
    try {
      const url = selectedUrl();
      if (url !== pageUrl()) throw new Error("先に「この URL で開く」を押して変更先をプレビューしてください");
      const result = globalThis.__openWebMonitorExtract(selector, ignoreSelectors);
      if (!result.text) throw new Error("抽出テキストがありません。選択を見直してください。");
      $(".save").disabled = true;
      const response = await chrome.runtime.sendMessage(config?.id
        ? { type: "update", id: config.id, patch: { url, selector, ignoreSelectors } }
        : { type: "create", monitor: { url, title: document.title, selector, ignoreSelectors } });
      if (!response?.ok) throw new Error(response?.error || "保存に失敗しました");
      close();
    } catch (error) { $("#status").textContent = error.message; $(".save").disabled = false; }
  });
  document.addEventListener("pointerover", onHover, true);
  document.addEventListener("click", onPick, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", renderOverlays, true);
  window.addEventListener("resize", renderOverlays);
  updateUrlNote();
  render();
})();
