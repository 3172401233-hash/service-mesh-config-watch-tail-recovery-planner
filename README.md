# service-mesh-config-watch-tail-recovery-planner

控制面重启后，代理重新建立 watch 时往往只能收到尾部版本，缺口中发生的
cluster / route 删除不会出现在新快照里。若代理把缺失删除误判为“已收敛”，
就会继续向幽灵集群（ghost cluster）转发流量。

本工具是一个**纯离线的恢复规划器**：输入 watch 起止版本、ACK/NACK、快照、
资源依赖、删除 tombstone 和代理配置，计算尾部缺口范围，识别幽灵资源与悬空
依赖，并输出缺失资源、重建范围和代理恢复顺序。

## 运行环境

- Node.js 24.16.0（`engines` 要求 `>=24.16.0`）
- 无第三方依赖，仅使用 Node 内置模块与 `node:test`

## 离线边界

本工具**不连接控制面、不发起任何网络请求、不订阅 xDS 流**，也不会修改代理
本地状态。它只消费调用方提供的 JSON 输入并输出规划结果，适合作为代理恢复
流程中的前置决策组件或 CI 校验工具。

## 输入

JSON 对象（字段定义见 `lib/planner.js` 中的 `planRecovery`）：

| 字段 | 说明 |
| --- | --- |
| `proxyConfig.watchStartVersion` | 当前 watch 流起始版本（含） |
| `proxyConfig.watchTailVersion` | 重启后实际收到的尾部版本（含） |
| `proxyConfig.lastAckVersion` | 代理最后一次成功 ACK 的版本（含） |
| `proxyConfig.maxGapVersions` | 可容忍的最大缺口事件数，默认 1000 |
| `proxyConfig.typeRank` | 自定义资源类型下发顺序，默认 `cluster -> route` |
| `snapshot.complete` | 快照是否完整；`false` 视为部分快照 |
| `snapshot.version` / `snapshot.resources` | 快照版本与资源列表（可带 `dependencies`） |
| `heldResources` | 代理本地仍持有的资源，用于发现幽灵资源 |
| `tombstones` | 删除墓碑，需带 `version`，仅缺口区间内的生效 |
| `nacks` | NACK 列表，版本晚于最后 ACK 的视为未恢复 |
| `dependencyGraph` | 全局依赖图，键为 `type/id`，与资源自带依赖合并 |

## 规划规则

1. **缺口范围**：缺口为 `(lastAckVersion, watchStartVersion)`，即
   `[lastAckVersion + 1, watchStartVersion - 1]`。
2. **幽灵资源触发全量重建**：本地持有但快照中不存在的资源，若在缺口区间内
   没有对应 tombstone，标记为 `DELETED_WITHOUT_TOMBSTONE`，升级为全量重建。
3. **部分快照不可信**：`snapshot.complete === false` 时无法对账，直接全量重建。
4. **NACK 未恢复**：晚于最后 ACK 的 NACK 触发全量重建。
5. **版本回退 / 缺口超限**：尾部版本落后于 ACK 版本，或缺口事件数超过
   `maxGapVersions`，触发全量重建。
6. **ACK 不代表依赖完整**：单项 ACK 只说明该资源本身被接受。快照资源引用了
   不存在的依赖时上报 `MISSING_DEPENDENCY` 并阻塞收敛，等待补齐依赖。
7. **恢复顺序**：按依赖图拓扑排序，依赖在前（cluster 先于 route）；删除顺序
   为其逆序，先摘 route 再删 cluster；反向依赖闭包内的资源一并重建。

## 输出

`planRecovery` 返回的关键字段：

- `converged` / `blocked`：是否已收敛、是否因缺依赖等原因被阻塞
- `gap`：缺口起止版本、事件数、是否版本回退
- `missingResources`：缺失资源及原因（无 tombstone 删除 / 悬空依赖）
- `rebuild.mode`：`FULL` / `PARTIAL` / `NONE`
- `rebuild.scopeKeys`：需要重建的资源范围
- `recoveryOrder` / `removalOrder`：下发与摘除顺序
- `tombstonesApplied` / `removals`：生效墓碑与待删除（含 GHOST）资源

## 用法

库调用：

```js
import { planRecovery } from "./lib/index.js";
const plan = planRecovery(input);
```

CLI（支持文件或 stdin，`--check` 在未收敛时以退出码 1 结束）：

```bash
node bin/recovery-plan.js --input examples/ghost-cluster-route.json
cat examples/ghost-cluster-route.json | node bin/recovery-plan.js --check
```

## 测试

```bash
node --test
```

覆盖尾部缺口、无 tombstone 的幽灵删除、部分快照、NACK 未恢复、悬空依赖、
缺口超限、版本回退、正常收敛以及拓扑排序与依赖环等场景。

## 目录结构

```
lib/version.js    版本与缺口计算
lib/resources.js  资源键、依赖归一化、反向依赖与拓扑排序
lib/planner.js    恢复规划主逻辑
bin/              离线 CLI
test/             node:test 测试
examples/         示例输入
```
