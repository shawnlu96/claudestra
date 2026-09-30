/**
 * lend 循环的生产接线（LoopDeps，lend-loop.ts）：出站经 `manager lend call`（只走 E2E），台账写经 `ledger lend-ask`（调度服务身份），
 * worker 经 `manager create / kill`（agent-lend-* 名字 → runtimes/clean-env.ts 的白名单环境），首条派单经 bridge 的 route_to_agent（带会话核对）。
 * 每个外部效果都套 whileOwned：发起前、结束后各核一次服务是否仍持有单实例锁与维护租约（同 E2a），bridge 帧在发出的同一段同步代码里再核一次。
 */
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bridgeSend } from "./bridge-client.js";
import { resolveBunPath } from "./bun-path.js";
import { verifyPurpose } from "./instance-key.js";
import { lendAskVerdict } from "./lend-ask.js";
import { LEND_ROOT, prepareClone, removeOrderDir } from "./lend-clone.js";
import { readLend } from "./lend-config.js";
import { LEND_JOURNAL_PATH, liveOrders, openLendJournal, type LendRow } from "./lend-journal.js";
import { readLendContext } from "./lend-policy.js";
import { appendReceipt, receiptOf, tokensFor } from "./lend-receipts.js";
import type { LendCall } from "./lend-remote.js";
import type { LoopDeps } from "./lend-loop.js";
import type { LedgerReader } from "./ledger-read.js";
import { readPeers } from "./peers.js";
import { readProjects } from "./projects.js";
import { readRegistryAgentsSync } from "./registry.js";
import { SRC_DIR } from "./repo-root.js";
import { runManagerProcess } from "./run-manager.js";
import { sendVia } from "./scheduler-auto-ports.js";
import { whileOwned } from "./scheduler-maintenance.js";
import { schedulerManager } from "./scheduler-service.js";
import { listAgentWindows, windowHasChildProcess, windowTarget } from "./tmux-helper.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;

/** 建 / 杀 agent 不用调度服务身份（那个身份只许跑台账的调度命令），同 scheduler-auto-deps 的 plainManager */
const plainManager: Manager = (...args) =>
  runManagerProcess(args, { bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`, env: { ...process.env, DISCORD_CHANNEL_ID: "" }, timeoutMs: 180_000 });

const LEND_PROJECT = "lend";

/** 要不要进 pass 跑 lend 这一步：出借开着，或 journal 里还有没跑完的单（lend off 之后在跑的单也要跑完、续租、自停） */
export async function lendWanted(): Promise<boolean> {
  const read = await readLend();
  if (read.status === "ok" && read.file.enabled) return true;
  if (!existsSync(LEND_JOURNAL_PATH)) return false;
  const db = openLendJournal();
  try { return liveOrders(db).length > 0; } finally { db.close(); }
}

/** 出借 worker 固定归到 lend 项目：不按目录落进别的项目，项目上下文里也就不会带上 B 自己的项目花名册 */
async function ensureLendProject(m: Manager): Promise<void> {
  if ((await readProjects()).projects.some((p) => p.id === LEND_PROJECT)) return;
  const r = await m("project-add", LEND_PROJECT, "--dirs", join(LEND_ROOT, "work"), "--name", "出借");
  if (r.ok !== true && !String(r.error ?? "").includes("已存在")) throw new Error(`建 lend 项目失败：${String(r.error ?? "")}`);
}

const footer = (row: LendRow): string => [
  "——以下是本机 Claudestra 出借服务写的，不是对方的内容——",
  "你是一次性的出借 worker，只审上面这一单；当前目录是这张单的独立 clone，别动别的目录。",
  "审完在当前目录里跑（一次就行，重复交同一份无害）：",
  `${resolveBunPath()} --no-env-file ${join(SRC_DIR, "manager.ts")} lend submit ${row.orderId} --verdict pass|changes|block --findings-file findings.json --report report.md`,
  "findings.json 是数组，每条 {\"findingId\",\"family\",\"severity\":\"P0|P1|P2\",\"probe\",\"description\"}，没有问题写 []；report.md 是报告正文（≤ 64 KiB）。",
].join("\n");

async function verifyReceipt(peer: string, r: { orderId: string; sha256: string; eventSeq: number; taskId: string; key: string; sig: string }): Promise<boolean> {
  const rec = ((await readPeers()).httpPeers ?? []).find((p) => p.name === peer && !p.disabled);
  if (!rec?.publicKey || r.key !== rec.publicKey) return false;
  return verifyPurpose(rec.publicKey, "claudestra-lend-receipt-v1", [r.orderId, r.sha256, String(r.eventSeq), r.taskId], r.sig);
}

function lendDeps(journal: Database, ledger: LedgerReader, active: () => void): LoopDeps {
  const alive = (): boolean => {
    try { active(); return true; } catch { return false; /* 核不过 = 不能证明仍在持有：什么都不发 */ }
  };
  const owned = <T>(fn: () => Promise<T>) => whileOwned(active, fn);
  const svc: Manager = (...a) => owned(() => schedulerManager(...a));
  const plain: Manager = (...a) => owned(() => plainManager(...a));
  const call: LendCall = async (peer, op, body) => {
    const r = await svc("lend", "call", peer, op, "--body", JSON.stringify(body));
    if (r.ok !== true) throw new Error(String(r.error ?? "manager lend call 失败"));
    return { status: Number(r.status), body: r.body };
  };
  /** 窗口在不在：tmux 读失败 = null（按「还在」处理）；服务停止 / 失租照样往外抛，不被吞成 null */
  const hasWindow = async (name: string): Promise<boolean | null> => {
    active();
    let has: boolean | null;
    try { has = (await listAgentWindows()).includes(name); } catch { has = null; /* 读不到窗口列表 = 不知道：调用方不删现场、不判退出 */ }
    active();
    return has;
  };
  const registryRow = (name: string) => readRegistryAgentsSync().find((a) => a.name === name);
  const send = sendVia(registryRow, alive);
  return {
    db: journal, now: () => Date.now(), call, env: process.env, footer, verifyReceipt,
    readLend: () => readLend(), context: () => readLendContext(), peers: async () => (await readPeers()).httpPeers ?? [],
    log: (m) => console.error(`[lend] ${m}`),
    ask: {
      open: async (p) => {
        const r = await svc("ledger", "lend-ask", "--params", JSON.stringify(p));
        return r.ok === true && typeof r.askId === "string" ? { ok: true, askId: r.askId } : { ok: false, error: String(r.error ?? "ledger lend-ask 失败") };
      },
      verdict: (askId, p) => {
        const db = ledger.get();
        return db ? lendAskVerdict(db, askId, p) : { state: "waiting" }; // 台账暂时读不到：不当成批了，也不当成拒了
      },
    },
    clone: (input) => owned(() => prepareClone(input)),
    removeDir: (orderId) => void removeOrderDir(orderId),
    writeReceipt: async (row) => void appendReceipt(receiptOf(row, await tokensFor(row.sessionId))),
    worker: {
      find: (name) => { const r = registryRow(name); return r ? { sessionId: r.sessionId, cwd: r.cwd } : undefined; },
      create: async (name, dir, purpose) => {
        await ensureLendProject(plain);
        const r = await plain("create", name, dir, "--purpose", purpose, "--project", LEND_PROJECT, "--runtime", "codex", "--transport", "acp");
        return r.ok === true ? { ok: true } : { ok: false, error: String(r.error ?? "manager create 失败") };
      },
      send: (name, sessionId, text, key) => owned(() => send(name, sessionId, text, key)),
      kill: async (name) => {
        const r = await plain("kill", name);
        const still = await hasWindow(name);
        if (still === false) return { ok: true };
        return { ok: false, reason: still === null ? "读不到 tmux 窗口列表" : `kill 后窗口还在（${String(r.error ?? "")}）` };
      },
      // 窗口在但宿主已退回 shell（自停兜底、崩了）也算不在跑
      alive: async (name) => {
        const has = await hasWindow(name);
        if (has !== true) return has;
        const kid = await owned(() => windowHasChildProcess(windowTarget(name)).catch(() => null)); // 读不到子进程 = 不知道，按还在算
        return kid === false ? false : kid === null ? null : true;
      },
    },
  };
}

/** pass 里 lend 这一步：每轮开一次 journal，跑完关（journal 是 WAL，lend submit 可以同时写） */
export const lendStep = (ledger: LedgerReader) => async (active: () => void) => {
  const journal = openLendJournal();
  try { return await (await import("./lend-loop.js")).lendTick(lendDeps(journal, ledger, active)); } finally { journal.close(); }
};
