import test from "node:test";
import assert from "node:assert/strict";
import { cleanUrl, cleanInterval, cleanConcurrency, runWithConcurrency, intervalParts, intervalFromParts, intervalLabel, cleanIgnoreSelectors, normalizeText, difference } from "./lib.js";

test("web URL only, without fragment", () => {
  assert.equal(cleanUrl("https://example.com/page#part"), "https://example.com/page");
  assert.throws(() => cleanUrl("file:///secret"));
  assert.throws(() => cleanUrl("javascript:alert(1)"));
});

test("interval is an integer from 1 minute to one week", () => {
  assert.equal(cleanInterval("15"), 15);
  assert.throws(() => cleanInterval(0));
  assert.throws(() => cleanInterval(1.5));
  assert.throws(() => cleanInterval(10081));
});

test("interval editor round trips minutes, hours and days", () => {
  for (const minutes of [1, 15, 60, 90, 1440, 2880, 10080]) {
    const parts = intervalParts(minutes);
    assert.equal(intervalFromParts(parts.value, parts.unit), minutes);
  }
  assert.equal(intervalLabel(1440), "1 日");
  assert.throws(() => intervalFromParts(8, "day"));
  assert.throws(() => intervalFromParts(1.5, "hour"));
});

test("normalization ignores whitespace-only changes", () => {
  assert.equal(normalizeText("  A\n\t B  "), "A B");
});

test("ignored selectors accept multiple lines and reject oversized rules", () => {
  assert.deepEqual(cleanIgnoreSelectors("article header\n.ad\n"), ["article header", ".ad"]);
  assert.deepEqual(cleanIgnoreSelectors([".ad", "  #footer  "]), [".ad", "#footer"]);
  assert.throws(() => cleanIgnoreSelectors(["a".repeat(501)]));
});

test("difference isolates changed middle content", () => {
  assert.deepEqual(difference("Price 100 yen", "Price 120 yen"), { before: "0", after: "2" });
  assert.deepEqual(difference("abc", "abc"), { before: "", after: "" });
});

test("all due monitors run within the selected concurrency, including beyond 24", async () => {
  const items = Array.from({ length: 31 }, (_, index) => index);
  const processed = [];
  let active = 0;
  let peak = 0;
  const errors = await runWithConcurrency(items, 3, async item => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    processed.push(item);
    active--;
    if (item === 10) throw new Error("one check failed");
  });
  assert.equal(processed.length, 31);
  assert.equal(peak, 3);
  assert.equal(errors.length, 1);
  assert.equal(cleanConcurrency("4"), 4);
  assert.throws(() => cleanConcurrency(0));
  assert.throws(() => cleanConcurrency(1.5));
});
