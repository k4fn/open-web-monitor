// Injected into the extension's isolated world in both the picker and check tabs.
globalThis.__openWebMonitorExtract = (selector, ignoreSelectors = []) => {
  const matched = [...document.querySelectorAll(selector || "body")];
  const matchedSet = new Set(matched);
  const roots = matched.filter(root => {
    for (let parent = root.parentElement; parent; parent = parent.parentElement) if (matchedSet.has(parent)) return false;
    return true;
  });
  if (!roots.length) throw new Error(`監視対象が見つかりません: ${selector}`);
  const ignored = ignoreSelectors.filter(Boolean);
  for (const rule of ignored) document.querySelectorAll(rule); // Validate every rule, including unmatched ones.
  const chunks = [];
  const ignoredElements = new Set();
  const hiddenCache = new WeakMap();
  let length = 0;
  for (const root of roots) {
    for (const rule of ignored) {
      if (root.matches(rule)) ignoredElements.add(root);
      for (const element of root.querySelectorAll(rule)) ignoredElements.add(element);
    }
    if (ignoredElements.has(root)) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || parent.closest("script,style,noscript,template,[hidden]")) continue;
      if (ignored.some(rule => parent.closest(rule))) continue;
      let hidden = false;
      for (let element = parent; element; element = element.parentElement) {
        if (hiddenCache.has(element)) { hidden = hiddenCache.get(element); break; }
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") { hidden = true; break; }
        if (element === root) break;
      }
      hiddenCache.set(parent, hidden);
      if (hidden) continue;
      const value = node.nodeValue.trim();
      if (!value) continue;
      chunks.push(value);
      length += value.length + 1;
      if (length >= 100_000) break;
    }
    if (length >= 100_000) break;
  }
  return {
    text: chunks.join(" ").replace(/\s+/g, " ").trim().slice(0, 100_000),
    title: document.title,
    matchCount: roots.length,
    ignoredCount: ignoredElements.size
  };
};
