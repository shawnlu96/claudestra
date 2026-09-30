/**
 * lend 循环的生产接线（LoopDeps，lend-loop.ts）：出站经 `manager lend call`（只走 E2E），台账写经 `ledger lend-ask`（调度服务身份），
 * worker 经 `manager create / kill`（agent-lend-* 名字 → runtimes/clean-env.ts 的白名单环境），首条派单经 bridge 的 route_to_agent（带会话核对）。
 * 每个外部效果都套 whileOwned：发起前、结束后各核一次服务是否仍持有单实例锁与维护租约（同 E2a），bridge 帧在发出的同一段同步代码里再核一次。
 * 写单（i28-R6）：本机指纹按实例公钥算，推送 / 开 PR 经 lend-push.ts（出借人自己的 git / gh 登录），派单尾注换成「提交后 lend submit 交摘要」。
 */
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bridgeSend } from "./bridge-client.js";
import { resolveBunPath } from "./bun-path.js";
import { instanceKeySync, keyFingerprint, verifyPurpose } from "./instance-key.js";
import { lendAskVerdict } from "./lend-ask.js";
import { LEND_ROOT, prepareClone, removeOrderDir } from "./lend-clone.js";
import { readLend } from "./lend-config.js";
import { isWriteStep } from "./lend-git.js";
import { ensurePr, probePush, pushWork } from "./lend-push.js";
import { guardJournalWrites, LEND_JOURNAL_PATH, liveOrders, openLendJournal, orderOf, unsettledOrders, type LendRow } from "./lend-journal.js";
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
import { BUN_NO_AUTOLOAD } from "./runtimes/clean-env.js";
import { sendVia } from "./scheduler-auto-ports.js";
import { encodeLease, SCHEDULER_LEASE_ENV, type SchedulerLease } from "./scheduler-lease-env.js";
import { whileOwned } from "./scheduler-maintenance.js";
import { schedulerManagerWith } from "./scheduler-service.js";
import { listAgentWindows, windowHasChildProcess, windowTarget } from "./tmux-helper.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;

/** 建 / 杀 agent 不用调度服务身份（那个身份只许跑台账的调度命令），同 scheduler-auto-deps 的 plainManager：也带服务租约，服务停了排队中的建 / 杀什么都不做 */
const plainManager = (lease: SchedulerLease | undefined): Manager => (...args) => runManagerProcess(args, { bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`,
  env: { ...process.env, DISCORD_CHANNEL_ID: "", [SCHEDULER_LEASE_ENV]: encodeLease(lease) }, timeoutMs: 180_000 });

const LEND_PROJECT = "lend";

/**
 * 要不要进 pass 跑 lend 这一步：出借开着，或 journal 里还有没跑完的单、没做完的收尾（lend off 之后在跑的单也要跑完、续租、自停，
 * 终态之后没写成的收据 / 没发出的通知也要补上：收尾不看出借开关）
 */
export async function lendWanted(journal = LEND_JOURNAL_PATH, lendPath?: string): Promise<boolean> {
  const read = await readLend(lendPath);
  if (read.status === "ok" && read.file.enabled) return true;
  if (!existsSync(journal)) return false;
  const db = openLendJournal(journal);
  try { return liveOrders(db).length > 0 || unsettledOrders(db).length > 0; } finally { db.close(); }
}

/** 出借 worker 固定归到 lend 项目：不按目录落进别的项目，项目上下文里也就不会带上 B 自己的项目花名册 */
async function ensureLendProject(m: Manager): Promise<void> {
  if ((await readProjects()).projects.some((p) => p.id === LEND_PROJECT)) return;
  const r = await m("project-add", LEND_PROJECT, "--dirs", join(LEND_ROOT, "work"), "--name", "出借");
  if (r.ok !== true && !String(r.error ?? "").includes("已存在")) throw new Error(`建 lend 项目失败：${String(r.error ?? "")}`);
}

const submitCmd = (row: LendRow): string => `${resolveBunPath()} ${BUN_NO_AUTOLOAD.join(" ")} ${join(SRC_DIR, "manager.ts")} lend submit ${row.orderId}`;

const reviewFooter = (row: LendRow): string[] => [
  "你是一次性的出借 worker，只审上面这一单；当前目录是这张单的独立 clone，别动别的目录。",
  "审完在当前目录里跑（一次就行，重复交同一份无害）：",
  `${submitCmd(row)} --verdict pass|changes|block --findings-file findings.json --report report.md`,
  "findings.json 是数组，每条 {\"findingId\",\"family\",\"severity\":\"P0|P1|P2\",\"probe\",\"description\"}，没有问题写 []；report.md 是报告正文（≤ 64 KiB）。",
  "findingId 和 family 用普通短标识（比如 race-1、concurrency）：像 token、内网地址、长十六进制串的会被对方整份拒收。",
];

/** 写单：只在当前分支上提交；这个副本推不出去（推送由出借服务做），摘要 / 自查走文件，不进命令行参数 */
const writeFooter = (row: LendRow): string[] => [
  `你是一次性的出借 worker，只做上面这一单；当前目录是这张单的独立 clone，已检出订单分支 ${row.wire?.write?.branch ?? "（见标题）"}，别动别的目录、别切别的分支。`,
  "改完在当前分支上 git commit（可以多次）；不要 git push——这个副本推不出去，推送与开 PR 由本机出借服务做，只推这一个分支。",
  "做完在当前目录里跑（一次就行，重复交同一份无害）：",
  `${submitCmd(row)} --summary-file summary.txt --self-check-file selfcheck.md`,
  "summary.txt 是一行摘要（≤ 500 字节）；selfcheck.md 是自查，逐条对验收线（≤ 4000 字节）。交的是当前分支的 HEAD，交之前先提交干净。",
];

const footer = (row: LendRow): string => ["——以下是本机 Claudestra 出借服务写的，不是对方的内容——",
  ...(isWriteStep(String(orderOf(row)?.step ?? "")) ? writeFooter(row) : reviewFooter(row))].join("\n");

/** 写单副本里的提交署名：出借人自己的 git 身份（全局配置）；没配就用一个明确的占位，不猜 */
function gitIdentity(): { name: string; email: string } {
  const get = (k: string): string => {
    try { return Bun.spawnSync(["git", "config", "--global", "--get", k], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim(); } catch { return ""; /* 没装 git / 没配：走占位 */ }
  };
  return { name: get("user.name") || "claudestra-lend", email: get("user.email") || "lend@claudestra.invalid" };
}

async function verifyReceipt(peer: string, r: { orderId: string; sha256: string; eventSeq: number; taskId: string; key: string; sig: string }): Promise<boolean> {
  const rec = ((await readPeers()).httpPeers ?? []).find((p) => p.name === peer && !p.disabled);
  if (!rec?.publicKey || r.key !== rec.publicKey) return false;
  return verifyPurpose(rec.publicKey, "claudestra-lend-receipt-v1", [r.orderId, r.sha256, String(r.eventSeq), r.taskId], r.sig);
}

function lendDeps(journal: Database, ledger: LedgerReader, active: () => void, lease: SchedulerLease | undefined): LoopDeps {
  const alive = (): boolean => {
    try { active(); return true; } catch { return false; /* 核不过 = 不能证明仍在持有：什么都不发 */ }
  };
  const owned = <T>(fn: () => Promise<T>) => whileOwned(active, fn);
  const svc: Manager = (...a) => owned(() => schedulerManagerWith(lease)(...a));
  const plain: Manager = (...a) => owned(() => plainManager(lease)(...a));
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
      inform: async (p) => {
        const r = await svc("ledger", "lend-inform", "--params", JSON.stringify(p));
        return r.ok === true && r.notified === true ? { ok: true } : { ok: false, error: String(r.error ?? r.why ?? "bridge 没收下通知") };
      },
      verdict: (askId, p) => {
        const db = ledger.get();
        return db ? lendAskVerdict(db, askId, p) : { state: "waiting" }; // 台账暂时读不到：不当成批了，也不当成拒了
      },
    },
    clone: (input) => owned(() => prepareClone(input)),
    removeDir: (orderId) => { active(); removeOrderDir(orderId); removeOrderDir(orderId, LEND_ROOT, "push"); },
    selfFp: () => { const k = instanceKeySync(); return k ? keyFingerprint(k.publicKey) : null; },
    identity: gitIdentity,
    push: { probe: (t) => owned(() => probePush(t)), work: (t) => owned(() => pushWork(t)), pr: (p) => owned(() => ensurePr(p)) },
    writeReceipt: async (row) => {
      const tokens = await tokensFor(row.sessionId);
      active(); // 查用量要 await：写收据前贴着再核
      appendReceipt(receiptOf(row, tokens));
    },
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
export const lendStep = (ledger: LedgerReader) => async (active: () => void, lease?: SchedulerLease) => {
  active(); // 打开 journal 会建目录 / 迁移：失租就连打开都不做
  const journal = openLendJournal();
  guardJournalWrites(journal, active);
  try { return await (await import("./lend-loop.js")).lendTick(lendDeps(journal, ledger, active, lease)); } finally { journal.close(); }
};
