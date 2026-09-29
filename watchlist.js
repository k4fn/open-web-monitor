export function visibleMonitorsForView(monitors, { view, selectedTag, query = "", recentlyRead = new Set(), sort = "activity" }) {
  const needle = query.trim().toLowerCase();
  return monitors.filter(monitor => {
    if (!(monitor.title + " " + monitor.url + " " + (monitor.text || "")).toLowerCase().includes(needle)) return false;
    if (view === "trash") return Boolean(monitor.trashedAt);
    if (monitor.trashedAt) return false;
    if (view === "unread") return monitor.history?.some(entry => !entry.read) || recentlyRead.has(monitor.id);
    if (view === "error") return monitor.status === "error";
    if (view === "tag") return monitor.tagIds?.includes(selectedTag);
    return true;
  }).sort((a, b) => {
    if (sort === "name") return a.title.localeCompare(b.title, "ja");
    if (sort === "checked") return (b.lastCheckAt || 0) - (a.lastCheckAt || 0);
    return (b.history?.[0]?.at || b.createdAt) - (a.history?.[0]?.at || a.createdAt);
  });
}

export async function openMonitorLinks(monitors, { createTab, markRead, onOpened = () => {} }) {
  let opened = 0, failed = 0, readFailed = 0;
  for (const monitor of monitors) {
    try {
      await createTab(monitor.url);
      opened++;
    } catch {
      failed++;
      continue;
    }
    onOpened(monitor);
    if (markRead && monitor.history?.some(entry => !entry.read)) {
      try { await markRead(monitor.id); }
      catch { readFailed++; }
    }
  }
  return { opened, failed, readFailed };
}

export function selectableMonitorIds(visibleMonitors) {
  return visibleMonitors.filter(monitor => !monitor.trashedAt).map(monitor => monitor.id);
}
