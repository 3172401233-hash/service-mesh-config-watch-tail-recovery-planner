/**
 * watch 尾部缺口恢复规划器（纯离线，不连接控制面）。
 *
 * 关键规则：
 * - 新快照缺失旧删除事件（缺口内没有对应 tombstone）时触发全量重建，
 *   代理本地残留的资源视为幽灵资源。
 * - 单项 ACK 只代表该资源本身被接受，不能证明依赖图完整；
 *   快照内任何悬空依赖都会作为缺失资源上报并阻塞收敛。
 * - NACK 未恢复、快照不完整、版本回退、缺口超过阈值都触发全量重建。
 */

import { computeGap, isWithinGap, isVersion, assertVersion } from "./version.js";
import {
  DEFAULT_TYPE_RANK,
  DependencyCycleError,
  buildReverseDependencies,
  dependentsClosure,
  normalizeDependencies,
  parseKey,
  resourceKey,
  topoSort,
} from "./resources.js";

export const RebuildMode = Object.freeze({
  FULL: "FULL",
  PARTIAL: "PARTIAL",
  NONE: "NONE",
});

export const MissingReason = Object.freeze({
  DELETED_WITHOUT_TOMBSTONE: "DELETED_WITHOUT_TOMBSTONE",
  MISSING_DEPENDENCY: "MISSING_DEPENDENCY",
});

export const RebuildReason = Object.freeze({
  DELETED_WITHOUT_TOMBSTONE: "DELETED_WITHOUT_TOMBSTONE",
  SNAPSHOT_NOT_COMPLETE: "SNAPSHOT_NOT_COMPLETE",
  VERSION_REGRESSION: "VERSION_REGRESSION",
  GAP_OVER_LIMIT: "GAP_OVER_LIMIT",
  NACK_PENDING: "NACK_PENDING",
  MISSING_DEPENDENCY: "MISSING_DEPENDENCY",
  DEPENDENCY_CYCLE: "DEPENDENCY_CYCLE",
});

const DEFAULT_MAX_GAP_VERSIONS = 1000;

function required(object, field, where) {
  if (object === null || object[field] === undefined) {
    throw new TypeError(`缺少必填字段 ${where}.${field}`);
  }
  return object[field];
}

function normalizeResource(resource, where) {
  if (!resource || typeof resource !== "object") {
    throw new TypeError(`${where} 中的资源必须是对象`);
  }
  required(resource, "type", where);
  required(resource, "id", where);
  return {
    type: String(resource.type),
    id: String(resource.id),
    version: resource.version,
    dependencies: resource.dependencies ?? [],
  };
}

/**
 * 根据 watch 范围、ACK/NACK、快照、依赖、tombstone 和代理配置，
 * 计算缺口范围并产出恢复计划。
 *
 * @param {object} input
 * @returns {object} 恢复计划（缺失资源、重建范围、恢复顺序）
 */
export function planRecovery(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("planRecovery 需要一个输入对象");
  }

  const proxyConfig = required(input, "proxyConfig", "input");
  const snapshotInput = required(input, "snapshot", "input");
  const watchStartVersion = required(
    proxyConfig,
    "watchStartVersion",
    "proxyConfig",
  );
  const watchTailVersion = required(
    proxyConfig,
    "watchTailVersion",
    "proxyConfig",
  );
  const lastAckVersion = required(proxyConfig, "lastAckVersion", "proxyConfig");
  const maxGapVersions =
    proxyConfig.maxGapVersions ?? DEFAULT_MAX_GAP_VERSIONS;
  const typeRank = { ...DEFAULT_TYPE_RANK, ...(proxyConfig.typeRank ?? {}) };

  assertVersion(watchStartVersion, "proxyConfig.watchStartVersion");
  assertVersion(watchTailVersion, "proxyConfig.watchTailVersion");
  assertVersion(lastAckVersion, "proxyConfig.lastAckVersion");
  if (!isVersion(maxGapVersions)) {
    throw new TypeError("proxyConfig.maxGapVersions 必须是非负安全整数");
  }

  const complete = snapshotInput.complete !== false;
  const snapshotVersion = required(snapshotInput, "version", "snapshot");
  assertVersion(snapshotVersion, "snapshot.version");
  const snapshotResources = (snapshotInput.resources ?? []).map((resource) =>
    normalizeResource(resource, "snapshot.resources"),
  );
  const heldResources = (input.heldResources ?? []).map((resource) =>
    normalizeResource(resource, "heldResources"),
  );
  const tombstones = (input.tombstones ?? []).map((tombstone) => {
    if (!tombstone || !tombstone.type || !tombstone.id) {
      throw new TypeError("tombstone 必须包含 type 和 id");
    }
    assertVersion(tombstone.version, "tombstone.version");
    return { ...tombstone, type: String(tombstone.type), id: String(tombstone.id) };
  });

  const gap = computeGap(watchStartVersion, watchTailVersion, lastAckVersion);
  const targetKeys = new Set(snapshotResources.map((r) => resourceKey(r.type, r.id)));
  const heldKeys = new Set(heldResources.map((r) => resourceKey(r.type, r.id)));

  const deps = normalizeDependencies(
    [...snapshotResources, ...heldResources],
    input.dependencyGraph ?? {},
  );
  const reverse = buildReverseDependencies(deps);

  const fullRebuildReasons = [];
  const blockedReasons = [];
  const missingResources = [];
  const seenMissing = new Set();
  const recordMissing = (entry) => {
    const dedupeKey = `${entry.type}/${entry.id}:${entry.reason}:${entry.missingDependency ?? ""}`;
    if (!seenMissing.has(dedupeKey)) {
      seenMissing.add(dedupeKey);
      missingResources.push(entry);
    }
  };

  // ---- 全量重建触发条件 -------------------------------------------------

  if (!complete) {
    fullRebuildReasons.push(RebuildReason.SNAPSHOT_NOT_COMPLETE);
  }
  if (gap.versionRegressed || snapshotVersion < lastAckVersion) {
    fullRebuildReasons.push(RebuildReason.VERSION_REGRESSION);
  }
  if (gap.missingEvents > maxGapVersions) {
    fullRebuildReasons.push(RebuildReason.GAP_OVER_LIMIT);
  }

  const pendingNacks = (input.nacks ?? [])
    .filter((nack) => {
      assertVersion(nack.version, "nack.version");
      return nack.version > lastAckVersion;
    })
    .map((nack) => ({
      version: nack.version,
      type: nack.type ? String(nack.type) : undefined,
      id: nack.id ? String(nack.id) : undefined,
      reason: nack.reason ?? "NACK",
    }));
  if (pendingNacks.length > 0) {
    fullRebuildReasons.push(RebuildReason.NACK_PENDING);
  }

  // 缺口内的 tombstone 才是代理没处理过的删除事件。
  const gapTombstones = tombstones.filter((tombstone) =>
    isWithinGap(tombstone.version, gap),
  );
  const tombstoneKeys = new Set(
    gapTombstones.map((tombstone) => resourceKey(tombstone.type, tombstone.id)),
  );

  // ---- 幽灵资源：本地有、快照没有 --------------------------------------

  const removals = [];
  for (const key of heldKeys) {
    if (targetKeys.has(key)) {
      continue;
    }
    const { type, id } = parseKey(key);
    if (tombstoneKeys.has(key)) {
      removals.push({ type, id, reason: "TOMBSTONE" });
      continue;
    }
    // 没有删除事件佐证的本地资源就是幽灵资源：删除事件在尾部缺口中丢失。
    removals.push({ type, id, reason: "GHOST" });
    recordMissing({
      type,
      id,
      reason: MissingReason.DELETED_WITHOUT_TOMBSTONE,
    });
    fullRebuildReasons.push(RebuildReason.DELETED_WITHOUT_TOMBSTONE);
  }

  // ---- 依赖图完整性（ACK 不能替代依赖校验）----------------------------

  for (const key of targetKeys) {
    for (const dep of deps.get(key) ?? []) {
      if (targetKeys.has(dep) || tombstoneKeys.has(dep)) {
        continue;
      }
      const { type, id } = parseKey(key);
      recordMissing({
        type,
        id,
        reason: MissingReason.MISSING_DEPENDENCY,
        missingDependency: dep,
      });
      fullRebuildReasons.push(RebuildReason.MISSING_DEPENDENCY);
      blockedReasons.push(RebuildReason.MISSING_DEPENDENCY);
    }
  }

  // ---- 重建范围 --------------------------------------------------------

  let mode;
  let scopeKeys;

  const uniqueReasons = [...new Set(fullRebuildReasons)];
  if (uniqueReasons.length > 0) {
    mode = RebuildMode.FULL;
    scopeKeys = new Set(targetKeys);
  } else {
    // 增量重建：删除/变更资源及其反向依赖闭包。
    const changedKeys = new Set();
    for (const resource of snapshotResources) {
      const key = resourceKey(resource.type, resource.id);
      const held = heldResources.find(
        (candidate) => resourceKey(candidate.type, candidate.id) === key,
      );
      if (!held || (isVersion(resource.version) && resource.version > lastAckVersion)) {
        changedKeys.add(key);
      }
    }
    const partialSeed = new Set([
      ...changedKeys,
      ...removals.map((entry) => resourceKey(entry.type, entry.id)),
    ]);
    scopeKeys = new Set(
      [...dependentsClosure(partialSeed, reverse)].filter((key) =>
        targetKeys.has(key),
      ),
    );
    mode = scopeKeys.size > 0 || removals.length > 0
      ? RebuildMode.PARTIAL
      : RebuildMode.NONE;
  }

  // ---- 恢复顺序（依赖在前）与删除顺序（反向）--------------------------

  let recoveryOrder = [];
  try {
    recoveryOrder =
      mode === RebuildMode.NONE
        ? []
        : topoSort(scopeKeys, deps, typeRank);
  } catch (error) {
    if (error instanceof DependencyCycleError) {
      blockedReasons.push(RebuildReason.DEPENDENCY_CYCLE);
      if (!uniqueReasons.includes(RebuildReason.DEPENDENCY_CYCLE)) {
        uniqueReasons.push(RebuildReason.DEPENDENCY_CYCLE);
      }
      mode = RebuildMode.FULL;
      scopeKeys = new Set(targetKeys);
      recoveryOrder = [];
    } else {
      throw error;
    }
  }

  const removalOrder = (() => {
    const removedKeys = removals.map((entry) => resourceKey(entry.type, entry.id));
    if (removedKeys.length === 0) {
      return [];
    }
    try {
      // 依赖在前的顺序反过来，确保先摘 route 再删 cluster。
      return topoSort(removedKeys, deps, typeRank).reverse();
    } catch (error) {
      if (error instanceof DependencyCycleError) {
        return [...removedKeys].sort().reverse();
      }
      throw error;
    }
  })();

  const sortedScope = [...scopeKeys].sort();
  const converged = mode === RebuildMode.NONE && blockedReasons.length === 0;

  return {
    proxyId: proxyConfig.proxyId,
    converged,
    blocked: blockedReasons.length > 0,
    gap: {
      from: gap.gapFrom,
      to: gap.gapTo,
      missingEvents: gap.missingEvents,
      versionRegressed: gap.versionRegressed,
    },
    snapshot: { version: snapshotVersion, complete },
    nacked: pendingNacks,
    missingResources,
    tombstonesApplied: gapTombstones.map((tombstone) => ({
      type: tombstone.type,
      id: tombstone.id,
      version: tombstone.version,
    })),
    removals,
    rebuild: {
      mode,
      reasons: uniqueReasons,
      scopeKeys: sortedScope,
    },
    recoveryOrder,
    removalOrder,
    blockedReasons: [...new Set(blockedReasons)],
  };
}
