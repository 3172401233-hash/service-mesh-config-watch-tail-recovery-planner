#!/usr/bin/env node
/**
 * 离线恢复规划 CLI：读取 JSON 输入，打印恢复计划。
 * 不发起任何网络请求、不连接控制面。
 *
 * 用法：
 *   node bin/recovery-plan.js [--input plan-input.json] [--check]
 */

import { readFileSync } from "node:fs";
import { planRecovery } from "../lib/index.js";

function parseArgs(argv) {
  const args = { input: null, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--input" || token === "-i") {
      args.input = argv[++i];
    } else if (token === "--check") {
      args.check = true;
    } else if (token === "--help" || token === "-h") {
      args.help = true;
    } else {
      throw new Error(`未知参数：${token}`);
    }
  }
  return args;
}

function readStdin() {
  return readFileSync(0, "utf8");
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  process.stdout.write(
    [
      "用法: watch-recovery-plan [--input plan-input.json] [--check]",
      "",
      "  --input, -i  输入 JSON 文件路径；省略时从 stdin 读取",
      "  --check      计划未收敛时以退出码 1 结束（用于流水线检查）",
      "  --help, -h   显示帮助",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const raw = args.input ? readFileSync(args.input, "utf8") : readStdin();
const plan = planRecovery(JSON.parse(raw));
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);

if (args.check && !plan.converged) {
  process.exit(1);
}
