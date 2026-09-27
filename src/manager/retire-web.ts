/**
 * `claudestra retire-web`（docs/design-hosted-frontend.md §10 ④）：卸掉旧的 `next start` 服务 com.claudestra.web。
 * 前端已由 bridge 托管（BRIDGE_STATIC_DIR → web/out），这个 daemon 只会白跑或崩溃循环。
 * 只在新模式已验证、旧数据已备份时才动手（retireWebPlan 是纯判定，tests/retire-web.test.ts）：
 *   BRIDGE_STATIC_DIR 已配且目录里有 index.html、bridge 正在托管（/app-config.json 答 mode:"direct"）、
 *   ~/.claude-orchestrator/backups/web-*.tgz 存在（= migrate-web-state 跑过）。
 * 做的事：launchctl bootout（没 load 也无妨）+ 把 plist 挪进 backups/ 并打印回滚命令。永不删 ~/.claude-orchestrator/web/。
 */
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { bridgeHttpBase } from "../lib/bridge-port.js";
import { STATE_DIR } from "../lib/paths.js";
import { REPO_ROOT } from "../lib/repo-root.js";
import { LEGACY_WEB_DAEMON, legacyWebPlistPath, staticIndexExists, webStaticState } from "../lib/web-static.js";
import { output } from "./core.js";

export interface RetireFacts {
  /** .env 的 BRIDGE_STATIC_DIR */
  staticDir: string;
  /** 那个目录里有 index.html */
  staticIndex: boolean;
  /** bridge 的 /app-config.json 应答且 mode 为 direct */
  bridgeServing: boolean;
  /** backups/ 里 migrate-web-state 留下的 web-*.tgz */
  backups: string[];
  plistExists: boolean;
}

export type RetirePlan = { ok: true; plistExists: boolean } | { ok: false; missing: string[] };

/** 四个前置缺哪个就说哪个；都齐了才允许卸 */
export function retireWebPlan(f: RetireFacts): RetirePlan {
  const missing: string[] = [];
  if (!f.staticDir) missing.push(".env 没有 BRIDGE_STATIC_DIR（重跑 bun run setup 选上 Web，或手动加 BRIDGE_STATIC_DIR=<仓库>/web/out）");
  else if (!f.staticIndex) missing.push(`${f.staticDir} 里没有 index.html（cd web && npm run build）`);
  if (!f.bridgeServing) missing.push("bridge 没在托管前端（/app-config.json 不应答或 mode 不是 direct）：改完 .env 要 launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge，并先在新入口配对、确认能聊");
  if (f.backups.length === 0) missing.push("没有旧 web 数据的备份 backups/web-*.tgz：先跑 claudestra migrate-web-state");
  return missing.length ? { ok: false, missing } : { ok: true, plistExists: f.plistExists };
}

/** migrate-web-state 的备份文件名：web-<ISO 时间戳>.tgz */
export function isWebBackup(name: string): boolean {
  return /^web-.+\.tgz$/.test(name);
}

async function bridgeServesFrontend(): Promise<boolean> {
  try {
    const r = await fetch(`${bridgeHttpBase()}/app-config.json`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return false;
    return ((await r.json()) as { mode?: string }).mode === "direct";
  } catch (e) {
    console.warn(`⚠️ bridge 不应答 /app-config.json: ${(e as Error).message}`);
    return false;
  }
}

export async function cmdRetireWeb(): Promise<void> {
  const backupDir = join(STATE_DIR, "backups");
  const state = webStaticState(REPO_ROOT);
  const facts: RetireFacts = {
    staticDir: state.staticDir,
    staticIndex: staticIndexExists(state.staticDir),
    bridgeServing: await bridgeServesFrontend(),
    backups: existsSync(backupDir) ? readdirSync(backupDir).filter(isWebBackup) : [],
    plistExists: existsSync(legacyWebPlistPath()),
  };
  const plan = retireWebPlan(facts);
  if (!plan.ok) {
    output({ ok: false, error: "还不能退场旧 web 服务——先补齐下面的前置", missing: plan.missing, facts });
    process.exitCode = 1;
    return;
  }
  const uid = process.getuid?.() ?? 501;
  // 非 0 多半是「没 load」（早就停了 / 从没装过）：目标状态一致，照常挪 plist
  const bootedOut = spawnSync("launchctl", ["bootout", `gui/${uid}/${LEGACY_WEB_DAEMON}`], { encoding: "utf8" }).status === 0;
  let backupPlist: string | null = null;
  if (plan.plistExists) {
    mkdirSync(backupDir, { recursive: true });
    backupPlist = join(backupDir, `${LEGACY_WEB_DAEMON}.plist.${new Date().toISOString().replace(/[:.]/g, "-")}`);
    renameSync(legacyWebPlistPath(), backupPlist);
  }
  output({
    ok: true,
    bootedOut,
    plist: backupPlist,
    note: plan.plistExists ? `${LEGACY_WEB_DAEMON} 已卸载，plist 备份在 ${backupPlist}` : `${LEGACY_WEB_DAEMON} 的 plist 本来就不在（已退场过）`,
    rollback: backupPlist
      ? `launchctl bootstrap gui/$(id -u) ${backupPlist}  # 要开机自启也回来，先把它复制回 ~/Library/LaunchAgents/`
      : null,
    kept: `${join(STATE_DIR, "web")}（旧数据只作废不删；还原 = 解开 backups/web-*.tgz）`,
  });
}
