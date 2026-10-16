/**
 * 安装入口的第一个 import：全新机器（只有 ~/.floka、没有旧根）时在 lib/paths.ts 加载之前跑 chooseFreshStateRoot 的缺省选择，
 * 否则入口一 import paths.ts 就在 defaultStateRoot 拒绝、安装器根本起不来。ESM 按 import 顺序求值，所以它必须排在入口的最前面。
 * 只在那个会让启动失败的情形里动手（不是全新机器 → chooseFreshStateRoot 只读返回 not-fresh）；显式给了状态目录（旧名 / 新名
 * STATE_DIR）就不碰 HOME；测试进程只认临时目录下的 HOME。拒绝时不抛：让 paths.ts 照原样报它自己的错。
 * 依赖与 fresh-root.ts 相同（不经 paths.ts）。tests/floka-install-config.test.ts。
 */
import { homedir } from "node:os";
import { readRenamedEnv } from "../floka-env/read.ts";
import { isTestProcess, isUnderTempDir } from "../test-guard.js";
import { chooseFreshStateRoot } from "./fresh-root.ts";

const home = homedir();
if (!(readRenamedEnv("STATE_DIR", process.env) || "").trim() && (!isTestProcess() || isUnderTempDir(home))) {
  const r = chooseFreshStateRoot(home);
  if (r.status === "chosen") console.error(`全新机器：状态根选 ${r.choice}（${r.root}）`);
}
