import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  MissingReason,
  RebuildMode,
  RebuildReason,
  planRecovery,
} from "../lib/index.js";

function baseInput(overrides = {}) {
  return {
    proxyConfig: {
      proxyId: "edge-proxy-7",
      watchStartVersion: 120,
      watchTailVersion: 125,
      lastAckVersion: 110,
    },
    snapshot: {
      version: 125,
      complete: true,
      resources: [
        { type: "cluster", id: "c1", version: 125 },
        {
          type: "route",
          id: "r1",
          version: 125,
          dependencies: ["cluster/c1"],
        },
      ],
    },
    heldResources: [
      { type: "cluster", id: "c1", version: 110 },
      {
        type: "route",
        id: "r1",
        version: 110,
        dependencies: ["cluster/c1"],
      },
    ],
    tombstones: [],
    nacks: [],
    dependencyGraph: {},
    ...overrides,
  };
}

test("尾部缺口内带 tombstone 的删除走增量重建，route 先于 cluster 摘除", () => {
  const input = baseInput();
  input.heldResources.push(
    { type: "cluster", id: "c-old", version: 112 },
    {
      type: "route",
      id: "r-old",
      version: 112,
      dependencies: ["cluster/c-old"],
    },
  );
  input.tombstones.push(
    { type: "cluster", id: "c-old", version: 115 },
    { type: "route", id: "r-old", version: 114 },
  );

  const plan = planRecovery(input);

  assert.equal(plan.gap.from, 111);
  assert.equal(plan.gap.to, 119);
  assert.equal(plan.gap.missingEvents, 9);
  assert.equal(plan.rebuild.mode, RebuildMode.PARTIAL);
  assert.deepEqual(plan.removalOrder, ["route/r-old", "cluster/c-old"]);
  assert.deepEqual(
    plan.recoveryOrder.filter((key) => ["cluster/c1", "route/r1"].includes(key)),
    ["cluster/c1", "route/r1"],
  );
  assert.equal(plan.missingResources.length, 0);
  assert.equal(plan.converged, false);
});

test("缺口内缺少删除 tombstone：幽灵 cluster/route 触发全量重建", () => {
  const input = baseInput();
  input.heldResources.push(
    { type: "cluster", id: "c-ghost", version: 112 },
    {
      type: "route",
      id: "r-ghost",
      version: 113,
      dependencies: ["cluster/c-ghost"],
    },
  );
  // 只有 route 的 tombstone，cluster 的删除事件在尾部缺口中丢失。
  input.tombstones.push({ type: "route", id: "r-ghost", version: 114 });

  const plan = planRecovery(input);

  assert.equal(plan.rebuild.mode, RebuildMode.FULL);
  assert.ok(
    plan.rebuild.reasons.includes(RebuildReason.DELETED_WITHOUT_TOMBSTONE),
  );
  assert.deepEqual(
    plan.missingResources.filter(
      (entry) => entry.reason === MissingReason.DELETED_WITHOUT_TOMBSTONE,
    ),
    [{ type: "cluster", id: "c-ghost", reason: MissingReason.DELETED_WITHOUT_TOMBSTONE }],
  );
  const ghostRemoval = plan.removals.find((entry) => entry.id === "c-ghost");
  assert.equal(ghostRemoval.reason, "GHOST");
  assert.deepEqual(plan.rebuild.scopeKeys, ["cluster/c1", "route/r1"]);
  assert.equal(plan.converged, false);
});

test("部分快照不可信，直接全量重建并阻止收敛", () => {
  const input = baseInput();
  input.snapshot.complete = false;
  input.heldResources.push({ type: "cluster", id: "c-ghost", version: 112 });

  const plan = planRecovery(input);

  assert.equal(plan.rebuild.mode, RebuildMode.FULL);
  assert.ok(
    plan.rebuild.reasons.includes(RebuildReason.SNAPSHOT_NOT_COMPLETE),
  );
  assert.equal(plan.snapshot.complete, false);
});

test("存在未恢复的 NACK 时全量重建，单项 ACK 不代表收敛", () => {
  const input = baseInput();
  input.nacks = [
    { version: 121, type: "cluster", id: "c1", reason: "invalid config" },
    { version: 105, type: "route", id: "r1", reason: "stale" },
  ];

  const plan = planRecovery(input);

  assert.equal(plan.rebuild.mode, RebuildMode.FULL);
  assert.ok(plan.rebuild.reasons.includes(RebuildReason.NACK_PENDING));
  assert.deepEqual(plan.nacked.map((entry) => entry.version), [121]);
  assert.equal(plan.converged, false);
});

test("单项 ACK 不能证明依赖图完整：悬空依赖上报并阻塞", () => {
  const input = baseInput();
  input.snapshot.resources.push({
    type: "route",
    id: "r2",
    version: 125,
    dependencies: ["cluster/missing"],
  });

  const plan = planRecovery(input);

  assert.equal(plan.rebuild.mode, RebuildMode.FULL);
  assert.ok(plan.rebuild.reasons.includes(RebuildReason.MISSING_DEPENDENCY));
  assert.equal(plan.blocked, true);
  assert.deepEqual(plan.missingResources, [
    {
      type: "route",
      id: "r2",
      reason: MissingReason.MISSING_DEPENDENCY,
      missingDependency: "cluster/missing",
    },
  ]);
});

test("缺口超过代理配置阈值时升级为全量重建", () => {
  const input = baseInput();
  input.proxyConfig.maxGapVersions = 5;

  const plan = planRecovery(input);

  assert.equal(plan.rebuild.mode, RebuildMode.FULL);
  assert.ok(plan.rebuild.reasons.includes(RebuildReason.GAP_OVER_LIMIT));
});

test("版本回退触发全量重建", () => {
  const input = baseInput();
  input.proxyConfig.watchTailVersion = 105;
  input.proxyConfig.watchStartVersion = 100;
  input.snapshot.version = 105;

  const plan = planRecovery(input);

  assert.equal(plan.rebuild.mode, RebuildMode.FULL);
  assert.ok(plan.rebuild.reasons.includes(RebuildReason.VERSION_REGRESSION));
});

test("无缺口、无差异时判定已收敛且无需重建", () => {
  const input = baseInput();
  input.proxyConfig.watchStartVersion = 111;
  input.proxyConfig.watchTailVersion = 111;
  input.snapshot.version = 111;
  input.snapshot.resources = [
    { type: "cluster", id: "c1", version: 110 },
    {
      type: "route",
      id: "r1",
      version: 110,
      dependencies: ["cluster/c1"],
    },
  ];

  const plan = planRecovery(input);

  assert.equal(plan.rebuild.mode, RebuildMode.NONE);
  assert.equal(plan.converged, true);
  assert.deepEqual(plan.recoveryOrder, []);
});

test("示例输入可以直接产出全量重建计划", () => {
  const raw = readFileSync(
    new URL("../examples/ghost-cluster-route.json", import.meta.url),
    "utf8",
  );
  const plan = planRecovery(JSON.parse(raw));

  assert.equal(plan.rebuild.mode, RebuildMode.FULL);
  assert.ok(
    plan.rebuild.reasons.includes(RebuildReason.DELETED_WITHOUT_TOMBSTONE),
  );
  assert.deepEqual(plan.removalOrder, ["route/r-ghost", "cluster/c-ghost"]);
  assert.deepEqual(plan.recoveryOrder, ["cluster/c1", "route/r1"]);
});
