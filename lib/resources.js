/** 资源键、依赖图与拓扑排序。 */

/** xDS 资源类型的默认下发顺序：cluster 先于 route。 */
export const DEFAULT_TYPE_RANK = Object.freeze({
  cluster: 0,
  route: 1,
});

export function resourceKey(type, id) {
  return `${type}/${id}`;
}

export function parseKey(key) {
  const index = key.indexOf("/");
  if (index <= 0) {
    throw new TypeError(`非法资源键：${key}`);
  }
  return { type: key.slice(0, index), id: key.slice(index + 1) };
}

function normalizeDep(dep, ownerType, ownerId) {
  if (typeof dep === "string") {
    return dep;
  }
  if (dep && typeof dep === "object" && dep.type && dep.id) {
    return resourceKey(dep.type, dep.id);
  }
  throw new TypeError(
    `${resourceKey(ownerType, ownerId)} 的依赖必须是 "type/id" 字符串或 {type,id} 对象`,
  );
}

/**
 * 归一化依赖。
 *
 * 支持两种写法：
 * 1. 每个资源自带 dependencies 字段（字符串键或 {type,id}）
 * 2. 输入顶层 dependencyGraph: { "type/id": ["type/id2", ...] }
 */
export function normalizeDependencies(resources, dependencyGraph = {}) {
  const deps = new Map();

  for (const resource of resources) {
    const key = resourceKey(resource.type, resource.id);
    const own = (resource.dependencies ?? []).map((dep) =>
      normalizeDep(dep, resource.type, resource.id),
    );
    const graph = (dependencyGraph[key] ?? []).map((dep) =>
      normalizeDep(dep, resource.type, resource.id),
    );
    deps.set(key, [...new Set([...own, ...graph])]);
  }

  for (const [key, list] of Object.entries(dependencyGraph)) {
    if (!deps.has(key)) {
      deps.set(key, [...new Set(list.map((dep) => normalizeDep(dep, key, "")))]);
    }
  }

  return deps;
}

/** 反向依赖：谁依赖了给定资源。 */
export function buildReverseDependencies(deps) {
  const reverse = new Map();
  for (const [key] of deps) {
    reverse.set(key, new Set());
  }
  for (const [key, list] of deps) {
    for (const dep of list) {
      if (!reverse.has(dep)) {
        reverse.set(dep, new Set());
      }
      reverse.get(dep).add(key);
    }
  }
  return reverse;
}

/** 沿反向依赖向上收集依赖者闭包（包含起点）。 */
export function dependentsClosure(keys, reverse) {
  const result = new Set();
  const stack = [...keys];
  while (stack.length > 0) {
    const current = stack.pop();
    if (result.has(current)) {
      continue;
    }
    result.add(current);
    for (const dependent of reverse.get(current) ?? []) {
      stack.push(dependent);
    }
  }
  return result;
}

export class DependencyCycleError extends Error {
  constructor(cycle) {
    super(`资源依赖图存在环：${cycle.join(" -> ")}`);
    this.name = "DependencyCycleError";
    this.cycle = cycle;
  }
}

/**
 * Kahn 拓扑排序（依赖在前）。
 * 同层节点按类型顺序（cluster -> route）、再按 id 字典序确定下发顺序。
 */
export function topoSort(keys, deps, typeRank = DEFAULT_TYPE_RANK) {
  const included = new Set(keys);
  const indegree = new Map();
  const adjacency = new Map();

  for (const key of included) {
    indegree.set(key, 0);
    adjacency.set(key, []);
  }

  for (const key of included) {
    for (const dep of deps.get(key) ?? []) {
      if (!included.has(dep)) {
        continue;
      }
      indegree.set(key, indegree.get(key) + 1);
      adjacency.get(dep).push(key);
    }
  }

  const rankOf = (key) => {
    const { type, id } = parseKey(key);
    return [typeRank[type] ?? Number.MAX_SAFE_INTEGER, type, id];
  };

  const ready = [...included]
    .filter((key) => indegree.get(key) === 0)
    .sort((a, b) => compareTuple(rankOf(a), rankOf(b)));

  const order = [];
  while (ready.length > 0) {
    const current = ready.shift();
    order.push(current);
    for (const next of adjacency.get(current)) {
      const remaining = indegree.get(next) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        insertSorted(ready, next, (key) => rankOf(key));
      }
    }
  }

  if (order.length !== included.size) {
    const remaining = [...included].filter((key) => !order.includes(key));
    throw new DependencyCycleError(remaining);
  }
  return order;
}

function compareTuple(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === right) {
      continue;
    }
    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    return String(left).localeCompare(String(right));
  }
  return 0;
}

function insertSorted(list, value, keyOf) {
  const key = keyOf(value);
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (compareTuple(keyOf(list[mid]), key) < 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  list.splice(low, 0, value);
}
