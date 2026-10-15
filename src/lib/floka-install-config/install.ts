/**
 * install-cli / update 里的 rename.installConfig 一步：off 直接返回（零读零写，旧安装逐字不变）；
 * observe 把逐项计划写进 warnings；on 跑一次事务（固定 txId，提交后重跑是空操作）。
 * 显式回滚：`bun src/lib/floka-install-config/install.ts rollback`。
 */
import { homedir } from "node:os";
import { CONFIG_PATH } from "../paths.js";
import { readJsonStateSync } from "../state-file.js";
import { maintenanceRoot } from "../state-maintenance/paths.js";
import { defaultJournalDir, rollbackInstallConfig, runInstallConfig } from "./run.js";
import { installConfigMode, installTarget } from "./plan.js";

const installConfigTx = (home: string, repoRoot: string): string => `install-config-1-${installTarget({ home, repoRoot })}`;

const currentConfig = (): unknown => {
  const r = readJsonStateSync(CONFIG_PATH);
  return r.status === "ok" ? r.data : {};
};

export async function installConfigWarnings(repoRoot: string, config: unknown = currentConfig(), home = homedir()): Promise<string[]> {
  if (installConfigMode(config) === "off") return [];
  const r = await runInstallConfig({ config, home, repoRoot, txId: installConfigTx(home, repoRoot), journalDir: defaultJournalDir(maintenanceRoot(home)) });
  const diff = r.plan.filter(p => p.action !== "keep").map(p => `${p.item} ${p.key}: ${p.action}`);
  if (r.mode === "observe") return [`rename.installConfig=observe（只报告，未写入）${diff.length ? `：${diff.join("；")}` : "：无差异"}`];
  return r.status === "committed" ? [] : [`rename.installConfig=on 未完成（${r.status}）：${r.error ?? "见维护根 install-config 日志"}`];
}

if (import.meta.main) {
  if (process.argv[2] !== "rollback") {
    console.error("用法: install.ts rollback");
    process.exit(2);
  }
  const home = homedir();
  const { REPO_ROOT } = await import("../repo-root.js");
  const r = await rollbackInstallConfig({ home, repoRoot: REPO_ROOT, txId: installConfigTx(home, REPO_ROOT), journalDir: defaultJournalDir(maintenanceRoot(home)) });
  console.log(JSON.stringify(r));
  process.exit(r.status === "rolled_back" ? 0 : 1);
}
