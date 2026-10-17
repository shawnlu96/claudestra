/**
 * 安装入口的第一个 import：全新机器（只有 ~/.floka、没有旧根）时在 lib/paths.ts 加载之前跑 chooseFreshStateRoot 的缺省选择，
 * 否则入口一 import paths.ts 就在 defaultStateRoot 拒绝、安装器根本起不来。ESM 按 import 顺序求值，所以它必须排在入口的最前面。
 * 真实入口（manager.ts install-cli、setup.ts，FRESHENTRY1）交给 fresh-entry-policy.ts：严格 fresh 判定 + 恢复键 installFreshEntry；
 * manager 的其他子命令什么都不做；其他进程（直接 import cli-install 的脚本）照 INSTALLCFG1 原样：只在会让启动失败的情形里动手（不是全新机器 → chooseFreshStateRoot
 * 只读返回 not-fresh）；显式给了状态目录（旧名 / 新名 STATE_DIR）就不碰 HOME；测试进程只认临时目录下的 HOME。拒绝时不抛：
 * 让 paths.ts 照原样报它自己的错。依赖与 fresh-root.ts 相同（不经 paths.ts）。tests/floka-install-config.test.ts、tests/floka-fresh-entry.test.ts。
 */
import { homedir } from "node:os";
import { readRenamedEnv } from "../floka-env/read.ts";
import { isTestProcess, isUnderTempDir } from "../test-guard.js";
import { freshEntryTarget, isEntryScript, runFreshEntry } from "./fresh-entry-policy.ts";
import { chooseFreshStateRoot } from "./fresh-root.ts";

const home = homedir();
const entry = freshEntryTarget();
if (!isTestProcess() || isUnderTempDir(home)) {
  if (entry) {
    const r = runFreshEntry(entry, home);
    if (r.action === "chosen" && r.result.status === "chosen") console.error(`全新机器：状态根选 ${r.result.choice}（${r.result.root}）`);
    if (r.action === "observed") console.error(`全新机器（installFreshEntry=observe）：本会选状态根 ${r.check.status === "fresh" ? r.check.choice : "-"}，未动手`);
  } else if (!isEntryScript() && !(readRenamedEnv("STATE_DIR", process.env) || "").trim()) {
    const r = chooseFreshStateRoot(home);
    if (r.status === "chosen") console.error(`全新机器：状态根选 ${r.choice}（${r.root}）`);
  }
}
