import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DependencyCycleError,
  buildReverseDependencies,
  dependentsClosure,
  normalizeDependencies,
  resourceKey,
  topoSort,
} from "../lib/resources.js";

function depsOf(graph) {
  return normalizeDependencies([], graph);
}

test("topoSort 保证 cluster 先于依赖它的 route", () => {
  const graph = depsOf({
    "route/r1": ["cluster/c1"],
    "route/r2": ["cluster/c1", "cluster/c2"],
    "cluster/c1": [],
    "cluster/c2": [],
  });
  const order = topoSort(
    ["route/r1", "route/r2", "cluster/c1", "cluster/c2"],
    graph,
  );
  assert.ok(order.indexOf("cluster/c1") < order.indexOf("route/r1"));
  assert.ok(order.indexOf("cluster/c2") < order.indexOf("route/r2"));
  assert.deepEqual(order, ["cluster/c1", "cluster/c2", "route/r1", "route/r2"]);
});

test("dependentsClosure 沿反向依赖收集整条依赖链", () => {
  const graph = depsOf({
    "route/r1": ["cluster/c1"],
    "route/r2": ["route/r1"],
    "cluster/c1": [],
  });
  const reverse = buildReverseDependencies(graph);
  const closure = dependentsClosure(["cluster/c1"], reverse);
  assert.deepEqual([...closure].sort(), [
    "cluster/c1",
    "route/r1",
    "route/r2",
  ]);
});

test("topoSort 遇到依赖环抛出 DependencyCycleError", () => {
  const graph = depsOf({
    "cluster/a": ["cluster/b"],
    "cluster/b": ["cluster/a"],
  });
  assert.throws(
    () => topoSort(["cluster/a", "cluster/b"], graph),
    DependencyCycleError,
  );
});

test("normalizeDependencies 合并资源自带依赖与全局 dependencyGraph", () => {
  const deps = normalizeDependencies(
    [
      {
        type: "route",
        id: "r1",
        dependencies: [{ type: "cluster", id: "c1" }],
      },
    ],
    { "route/r1": ["cluster/c2"] },
  );
  assert.deepEqual([...deps.get(resourceKey("route", "r1"))].sort(), [
    "cluster/c1",
    "cluster/c2",
  ]);
});
