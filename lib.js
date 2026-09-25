export const PREFIX = "monitor:";
export const MAX_HISTORY = 30;
export const MAX_TEXT = 100_000;

export function cleanUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("http または https の URL を入力してください");
  url.hash = "";
  return url.href;
}

export function cleanInterval(value) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw new Error("間隔は 1〜10080 分で指定してください");
  return minutes;
}

export function cleanConcurrency(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("同時確認数は 1 以上の整数で指定してください");
  return count;
}

export async function runWithConcurrency(items, limit, task) {
  let next = 0;
  const errors = [];
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try { await task(item); }
      catch (error) { errors.push(error); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(cleanConcurrency(limit), items.length) }, worker));
  return errors;
}

export function intervalParts(minutes) {
  if (minutes % 1440 === 0) return { value: minutes / 1440, unit: "day" };
  if (minutes % 60 === 0) return { value: minutes / 60, unit: "hour" };
  return { value: minutes, unit: "minute" };
}

export function intervalFromParts(value, unit) {
  const multiplier = { minute: 1, hour: 60, day: 1440 }[unit];
  if (!multiplier) throw new Error("確認間隔の単位を選択してください");
  const amount = Number(value);
  if (!Number.isInteger(amount) || amount < 1) throw new Error("確認間隔は 1 以上の整数で指定してください");
  return cleanInterval(amount * multiplier);
}

export function intervalLabel(minutes) {
  const { value, unit } = intervalParts(minutes);
  return `${value} ${ { minute: "分", hour: "時間", day: "日" }[unit] }`;
}

export function cleanIgnoreSelectors(value) {
  const selectors = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);
  const result = selectors.map(item => String(item).trim()).filter(Boolean);
  if (result.length > 30 || result.some(item => item.length > 500)) throw new Error("無視する要素は 30 件以内、各 500 文字以内にしてください");
  return result;
}

export function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

export function difference(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return {
    before: before.slice(start, oldEnd).slice(0, 1500),
    after: after.slice(start, newEnd).slice(0, 1500)
  };
}

export function monitorKey(id) { return PREFIX + id; }
export function isMonitorKey(key) { return key.startsWith(PREFIX); }
