import assert from "node:assert/strict";
import { test } from "node:test";

import { computeGap, isWithinGap } from "../lib/version.js";

test("computeGap 计算 ACK 与新 watch 流之间的尾部缺口", () => {
  const gap = computeGap(120, 125, 110);
  assert.deepEqual(
    { ...gap },
    {
      gapFrom: 111,
      gapTo: 119,
      missingEvents: 9,
      gap: true,
      versionRegressed: false,
    },
  );
});

test("无缺口时 missingEvents 为 0 且不标记 gap", () => {
  const gap = computeGap(111, 111, 110);
  assert.equal(gap.gap, false);
  assert.equal(gap.missingEvents, 0);
});

test("快照尾部版本落后于 ACK 版本时识别为版本回退", () => {
  const gap = computeGap(90, 95, 110);
  assert.equal(gap.versionRegressed, true);
  assert.equal(gap.gap, true);
  assert.equal(gap.missingEvents, 0);
});

test("isWithinGap 只命中缺口区间内的版本", () => {
  const gap = computeGap(120, 125, 110);
  assert.equal(isWithinGap(111, gap), true);
  assert.equal(isWithinGap(119, gap), true);
  assert.equal(isWithinGap(110, gap), false);
  assert.equal(isWithinGap(120, gap), false);
});

test("非法版本号直接抛错", () => {
  assert.throws(() => computeGap(-1, 2, 0), TypeError);
  assert.throws(() => computeGap(130, 120, 0), RangeError);
});
