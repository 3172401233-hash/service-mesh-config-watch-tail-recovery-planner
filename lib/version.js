/**
 * 版本与 watch 范围工具。
 *
 * 约定 watch 版本为单调递增整数；版本号只用于比较先后，
 * 控制面回退到更老的快照版本属于异常，需要全量重建。
 */

export function isVersion(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function assertVersion(value, field) {
  if (!isVersion(value)) {
    throw new TypeError(`${field} 必须是非负安全整数，实际收到 ${String(value)}`);
  }
}

/**
 * 计算 watch 缺口范围。
 *
 * @param {number} watchStartVersion 代理当前 watch 流的起始版本（含）
 * @param {number} watchTailVersion  重启后只收到的尾部版本（含）
 * @param {number} lastAckVersion    代理最后一次成功 ACK 的版本（含）
 * @returns {{gapFrom: number, gapTo: number, missingEvents: number,
 *            versionRegressed: boolean, gap: boolean}}
 */
export function computeGap(watchStartVersion, watchTailVersion, lastAckVersion) {
  assertVersion(watchStartVersion, "watchStartVersion");
  assertVersion(watchTailVersion, "watchTailVersion");
  assertVersion(lastAckVersion, "lastAckVersion");

  if (watchTailVersion < watchStartVersion) {
    throw new RangeError(
      `watchTailVersion(${watchTailVersion}) 不能小于 watchStartVersion(${watchStartVersion})`,
    );
  }

  const versionRegressed = watchTailVersion < lastAckVersion;

  // ACK 之后、新流起点之前的事件是代理没有见过的：
  // 区间 (lastAckVersion, watchStartVersion)，即 [lastAckVersion+1, watchStartVersion-1]。
  const gapFrom = lastAckVersion + 1;
  const gapTo = watchStartVersion - 1;
  const missingEvents = Math.max(0, gapTo - gapFrom + 1);

  return {
    gapFrom,
    gapTo,
    missingEvents,
    gap: missingEvents > 0 || versionRegressed,
    versionRegressed,
  };
}

/** 版本是否落在缺口区间内（含边界）。 */
export function isWithinGap(version, gap) {
  return (
    isVersion(version) &&
    gap.gap &&
    version >= gap.gapFrom &&
    version <= gap.gapTo
  );
}
