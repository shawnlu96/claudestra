/**
 * Codex 自动更新（开关 autoUpdate.codex，缺省关；launcher 主循环每轮调 pollCodexAutoUpdate，自己按时间表决定做不做）。
 *
 * 一轮：npm latest 比本机新 → 所有在跑的 transport=acp Codex agent（含出借 worker agent-lend-*）都空闲 → 占整机更新锁 →
 * prepareCodexUpdate 判能不能升（自研 = 协议判定，上游 = 配套范围；不在这里另判）→ npm install -g 钉死版本 → 逐个
 * manager restart，每个重启前再问一次空闲，忙的跳过（它下次重启自然用上新版）。
 * 闸拒绝（不兼容 / 判不出 / 无配套）同一个版本只通知一次；npm 失败每次通知，按 6h、12h、24h… 封顶 48h 退避。
 * 时间表落盘（codex-auto-update.json）：launcher 随 Claudestra 升级重启时不会把 6 小时的间隔清零。tests/codex-auto-update.test.ts。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "./config-store.js";
import { fetchLatestCodex, probeCodexInstall } from "./codex-version.js";
import { isNewerVersion } from "./update-hints.js";
import { readRegistryAgents } from "./registry.js";
import { normalizeTransport } from "./runtimes/index.js";
import { acpTurnGate } from "./acp-turn-gate.js";
import { bridgeRequest } from "./bridge-client.js";
import { notify } from "./notify.js";
import { runManagerProcess } from "./run-manager.js";
import { resolveBunPath } from "./bun-path.js";
import { SRC_DIR } from "./repo-root.js";
import { STATE_DIR } from "./paths.js";
import { writeJsonAtomicSync } from "./state-file.js";
import { prepareCodexUpdate, runInLoginShell, tryUpdateLock, type Prepared, type ShellResult } from "./codex-auto-update-gate.js";

const HOUR = 3600_000;
export const CHECK_EVERY_MS = 6 * HOUR;
/** 有 agent 忙 / 锁被网页按钮占着：不等 6 小时，半小时后再逮空闲窗口 */
export const BUSY_RETRY_MS = 30 * 60_000;
const OFF_RECHECK_MS = 5 * 60_000; // 开关关着：5 分钟看一次开关，打开后不用重启 launcher
const MAX_BACKOFF_MS = 48 * HOUR;
const STATE_PATH = join(STATE_DIR, "codex-auto-update.json");
const LOCK_LABEL = "Codex 自动更新";

export interface CodexAutoState {
  /** 下一次真正检查的时间（ms） */
  nextAt?: number;
  /** 已经通知过「闸拒绝」的版本：同一版本不再通知 */
  refusedVersion?: string;
  /** npm 连续失败：版本 + 次数，换了版本从头算 */
  failedVersion?: string;
  failures?: number;
}

type Agent = { name: string; runtime?: string; transport?: string; status?: string };
export interface CodexAutoDeps {
  now: () => number;
  enabled: () => Promise<boolean>;
  installed: () => Promise<{ version?: string; npm: boolean } | null>;
  latest: () => Promise<string | undefined>;
  agents: () => Promise<Agent[]>;
  /** 这些 agent 里在忙的（ACP 回合态，fail-closed：查不到算忙）；key = 目标版本，查不到时按它去重报 #control */
  busy: (names: string[], key: string) => Promise<string[]>;
  lock: (label: string) => Promise<{ release: () => void } | { holder: string }>;
  prepare: () => Promise<Prepared>;
  shell: (cmd: string) => Promise<ShellResult>;
  restart: (name: string) => Promise<{ ok?: boolean; error?: string } | null | undefined>;
  notify: (text: string) => Promise<boolean>;
  log: (msg: string) => void;
  load: () => CodexAutoState;
  save: (s: CodexAutoState) => void;
}

export type CodexAutoOutcome = "off" | "not-due" | "no-npm" | "up-to-date" | "busy" | "locked" | "refused" | "failed" | "updated";
export interface CodexAutoResult { outcome: CodexAutoOutcome; nextAt: number; restarted?: string[]; skipped?: string[] }

/** 闸要管的 agent：在跑的 Codex ACP 会话（出借 worker 也是这种 registry 条目）。tmux 的 Codex TUI 不经适配器，下次重启自然换新 */
export const gatedAgents = (all: Agent[]) =>
  all.filter((a) => a.runtime === "codex" && normalizeTransport(a.transport) === "acp" && a.status === "active").map((a) => a.name);

/** 第 n 次连续失败后等多久：6h、12h、24h，封顶 48h */
export const backoffMs = (failures: number) => Math.min(CHECK_EVERY_MS * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);

const hours = (ms: number) => `${Math.round(ms / HOUR)} 小时`;

export async function codexAutoUpdateTick(d: CodexAutoDeps): Promise<CodexAutoResult> {
  const now = d.now();
  if (!(await d.enabled())) return { outcome: "off", nextAt: now + OFF_RECHECK_MS };
  const st = d.load();
  if (st.nextAt && now < st.nextAt) return { outcome: "not-due", nextAt: st.nextAt };
  const done = (outcome: CodexAutoOutcome, wait: number, patch: CodexAutoState = {}, extra: Partial<CodexAutoResult> = {}) => {
    const next = { ...st, ...patch, nextAt: now + wait };
    d.save(next);
    return { outcome, nextAt: next.nextAt, ...extra };
  };
  const inst = await d.installed();
  if (!inst?.npm || !inst.version) return done("no-npm", CHECK_EVERY_MS); // 没装 / brew 等：不替人升，网页横幅照旧只给文字
  const latest = await d.latest().catch((e) => (d.log(`⚠️ [codex-auto-update] 查 npm latest 失败：${String(e)}`), undefined));
  if (!latest || !isNewerVersion(latest, inst.version)) return done("up-to-date", CHECK_EVERY_MS);
  const key = `codex ${latest}`;
  const gated = gatedAgents(await d.agents());
  const busy = await d.busy(gated, key);
  if (busy.length) {
    d.log(`🆙 Codex ${inst.version} → ${latest}，在忙：${busy.join(", ")}，半小时后再试`);
    return done("busy", BUSY_RETRY_MS);
  }
  const lock = await d.lock(LOCK_LABEL);
  if ("holder" in lock) return d.log(`🆙 Codex 更新锁被 ${lock.holder} 占着，半小时后再试`), done("locked", BUSY_RETRY_MS);
  try {
    return await upgradeLocked(d, { from: inst.version, latest, key, gated }, st, done);
  } finally {
    lock.release();
  }
}

type Done = (o: CodexAutoOutcome, wait: number, patch?: CodexAutoState, extra?: Partial<CodexAutoResult>) => CodexAutoResult;
type Target = { from: string; latest: string; key: string; gated: string[] };

async function upgradeLocked(d: CodexAutoDeps, target: Target, st: CodexAutoState, done: Done): Promise<CodexAutoResult> {
  let t = target;
  const fail = async (why: string) => {
    const failures = (st.failedVersion === t.latest ? st.failures ?? 0 : 0) + 1;
    const wait = backoffMs(failures);
    await d.notify(`⚠️ Codex 自动更新 ${t.from} → ${t.latest} 失败（第 ${failures} 次），${hours(wait)}后再试：${why}`);
    return done("failed", wait, { failedVersion: t.latest, failures });
  };
  const p = await d.prepare();
  if ("error" in p) {
    if (p.status >= 500) return fail(p.error); // 查不到 npm / 装配套适配器失败：和 npm 失败一样退避
    if (st.refusedVersion === t.latest) return done("refused", CHECK_EVERY_MS);
    // 送到了才记「说过了」：#control 一时不通就半小时后重判重发，否则 owner 一次都收不到、之后同版本永远静默
    const sent = await d.notify(`ℹ️ Codex ${t.latest} 不自动更新（本机 ${t.from}，同一版本只说这一次）：${p.error}`);
    return sent ? done("refused", CHECK_EVERY_MS, { refusedVersion: t.latest }) : done("refused", BUSY_RETRY_MS);
  }
  // 自研的闸要临时 npm 安装、生成 schema，能耗几分钟：期间有人开了回合 / 起了新 ACP agent，就别在它脚下换全局二进制。
  // 名单重读（不用锁外的快照），本轮作罢，半小时后再逮空闲窗口
  const gated = gatedAgents(await d.agents());
  const busyNow = await d.busy(gated, t.key);
  if (busyNow.length) {
    d.log(`🆙 Codex ${t.from} → ${t.latest}：判闸期间 ${busyNow.join(", ")} 开始忙，本轮不升，半小时后再试`);
    return done("busy", BUSY_RETRY_MS);
  }
  t = { ...t, gated };
  const r = await d.shell(p.command);
  if (!r.ok) return fail(`${p.command} 报错：${r.tail || "没有输出"}`);
  try { await p.afterShell?.(); } catch (e) {
    // npm 已经装上：下一轮本机就是 latest，不会再升；agent 不重启，免得在错配的适配器上起来
    await d.notify(`⚠️ Codex 已自动更新到 ${t.latest}，但切换适配器失败，没有重启任何 agent：${String(e)}。跑一次 manager acp-install 再逐个重启`);
    return done("failed", CHECK_EVERY_MS, { failedVersion: undefined, failures: 0 });
  }
  const restarted: string[] = [];
  const skipped: string[] = [];
  const broken: string[] = [];
  for (const name of t.gated) {
    if ((await d.busy([name], t.key)).length) { skipped.push(name); continue; } // 升级期间开了新回合：不打断，下次重启生效
    const rr = await d.restart(name).catch((e) => ({ ok: false, error: String(e) }));
    if (rr?.ok) restarted.push(name);
    else broken.push(`${name}（${rr?.error || "未知原因"}）`);
  }
  const parts = [
    `🆙 Codex 已自动更新 ${t.from} → ${t.latest}`,
    restarted.length ? `已重启：${restarted.join("、")}` : "",
    skipped.length ? `在忙没重启（下次重启生效）：${skipped.join("、")}` : "",
    broken.length ? `⚠️ 重启失败（可在管理面板手动重启）：${broken.join("、")}` : "",
  ];
  await d.notify(parts.filter(Boolean).join("\n"));
  return done("updated", CHECK_EVERY_MS, { failedVersion: undefined, failures: 0 }, { restarted, skipped });
}

function loadState(path = STATE_PATH): CodexAutoState {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch { return {}; /* 第一次跑 / 文件坏了：当作从没检查过，最坏多查一次 npm */ }
}

const mentionOwners = () => (process.env.ALLOWED_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean).map((id) => `<@${id}>`).join(" ");
const toControl = (text: string) => notify({ source: "launcher", chatId: process.env.CONTROL_CHANNEL_ID || "", text });
const LIVE: CodexAutoDeps = {
  now: Date.now,
  enabled: async () => (await readConfig()).autoUpdate.codex === true,
  installed: () => probeCodexInstall(),
  latest: fetchLatestCodex,
  agents: () => readRegistryAgents(),
  busy: acpTurnGate({
    query: (names) => bridgeRequest({ type: "turn_status", agents: names }, { timeoutMs: 10_000 }),
    notify: toControl,
    log: (msg) => console.warn(msg),
  }),
  lock: (label) => tryUpdateLock(label),
  prepare: () => prepareCodexUpdate(),
  shell: runInLoginShell,
  restart: (name) => runManagerProcess(["restart", name], { bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`, timeoutMs: 300_000 }),
  notify: (text) => toControl(`${text} ${mentionOwners()}`.trim()),
  log: (msg) => console.log(msg),
  load: () => loadState(),
  save: (s) => writeJsonAtomicSync(STATE_PATH, s),
};

let nextAt = 0;
let inflight = false;
/** launcher 主循环每轮调（15 秒一次）：没到时间只比一次内存里的时间戳；一轮最多同时一个 */
export function pollCodexAutoUpdate(deps: CodexAutoDeps = LIVE): void {
  if (inflight || Date.now() < nextAt) return;
  inflight = true;
  codexAutoUpdateTick(deps)
    .then((r) => { nextAt = r.nextAt; })
    .catch((e) => { nextAt = Date.now() + BUSY_RETRY_MS; console.error("Codex 自动更新检查异常:", e); })
    .finally(() => { inflight = false; });
}
