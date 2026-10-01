/**
 * lend 循环的生产接线（LoopDeps，lend-loop.ts）：出站经 `manager lend call`（只走 E2E），台账写经 `ledger lend-inform / lend-ask`（调度服务身份），
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
import { LEND_ROOT, prepareClone, removeOrderDir } from "./lend-clone.js";
import { readLend } from "./lend-config.js";
import { isWriteStep } from "./lend-git.js";
import { withPaneArchive } from "./lend-pane-archive.js";
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
import { codexFailure, sendVia } from "./scheduler-auto-ports.js";
import { encodeLease, SCHEDULER_LEASE_ENV, type SchedulerLease } from "./scheduler-lease-env.js";
import { whileOwned } from "./scheduler-maintenance.js";
import { schedulerManagerWith } from "./scheduler-service.js";
import { probeAcpWorker } from "./worker-liveness.js";
import { readInventoryQuota } from "./ai-quota.js";
import { quotaViewOf, type CodexFailureSeen } from "./lend-health.js";

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

/** 写单副本里的提交署名：出借人自己的 git 身份（全局配置）。缺一项就是 null，写单退回并说明，不用占位冒名、也不猜 */
function gitIdentity(): { name: string; email: string } | null {
  const get = (k: string): string => {
    try { return Bun.spawnSync(["git", "config", "--global", "--get", k], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim(); } catch { return ""; /* 没装 git：当没配，写单退回时会说明 */ }
  };
  const name = get("user.name");
  const email = get("user.email");
  return name && email ? { name, email } : null;
}

async function verifyReceipt(peer: string, r: { orderId: string; sha256: string; eventSeq: number; taskId: string; key: string; sig: string }): Promise<boolean> {
  const rec = ((await readPeers()).httpPeers ?? []).find((p) => p.name === peer && !p.disabled);
  if (!rec?.publicKey || r.key !== rec.publicKey) return false;
  return verifyPurpose(rec.publicKey, "claudestra-lend-receipt-v1", [r.orderId, r.sha256, String(r.eventSeq), r.taskId], r.sig);
}

/** 生产依赖。不设 writeOpen：写单在 W8 之前只认 lend-grant-rules.ts WRITE_ROLE_OPEN（tests/lend-grant.test.ts 钉住） */
export function lendDeps(journal: Database, ledger: LedgerReader, active: () => void, lease: SchedulerLease | undefined): LoopDeps {
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
  /** 读失败一律 unknown（worker-liveness.ts）；服务停止 / 失租照样往外抛，不被吞成 unknown */
  const probe = (name: string) => owned(() => probeAcpWorker(name));
  const registryRow = (name: string) => readRegistryAgentsSync().find((a) => a.name === name);
  const send = sendVia(registryRow, alive);
  return {
    db: journal, now: () => Date.now(), call, env: process.env, footer, verifyReceipt,
    readLend: () => readLend(), context: () => readLendContext(), peers: async () => (await readPeers()).httpPeers ?? [],
    log: (m) => console.error(`[lend] ${m}`),
    notify: async (p) => {
      const r = await svc("ledger", "lend-inform", "--params", JSON.stringify(p));
      return r.ok === true && r.notified === true ? { ok: true } : { ok: false, error: String(r.error ?? r.why ?? "bridge 没收下通知") };
    },
    retireAsk: async (askId) => {
      const r = await svc("ledger", "lend-ask", "--retire", askId);
      return r.ok === true ? { ok: true } : { ok: false, error: String(r.error ?? "ledger lend-ask --retire 失败") };
    },
    failure: (agent) => failureOf(ledger, agent),
    closeAsks: async (agent) => {
      const r = await svc("ledger", "lend-close-asks", "--agent", agent);
      return r.ok === true ? { ok: true } : { ok: false, error: String(r.error ?? "ledger lend-close-asks 失败") };
    },
    codexQuota: async () => quotaViewOf((await readInventoryQuota()).codex),
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
      create: async (name, dir, purpose, gate) => {
        await ensureLendProject(plain);
        const denied = await gate(); // 建项目要拿 manager 写锁：这段工夫里收回了就不起（之后的窗口由宿主起适配器前的同步核对兜住）
        if (denied) return { ok: false, error: denied };
        const r = await plain("create", name, dir, "--purpose", purpose, "--project", LEND_PROJECT, "--runtime", "codex", "--transport", "acp");
        return r.ok === true ? { ok: true } : { ok: false, error: String(r.error ?? "manager create 失败") };
      },
      send: (name, sessionId, text, key) => owned(() => send(name, sessionId, text, key)),
      kill: withPaneArchive(async (name) => { // kill 前先存 pane 现场（lend-pane-archive.ts），存档失败不挡 kill
        const r = await plain("kill", name);
        const still = await probe(name);
        if (still === "no_window") return { ok: true };
        return { ok: false, reason: still === "unknown" ? "读不到 tmux 窗口 / 进程，没法确认已退出" : `kill 后窗口还在（${String(r.error ?? "")}）` };
      }),
      alive: probe,
    },
  };
}

/** bridge 为这个 worker 开的 Codex 额度 / 登录卡（同 scheduler-auto-ports codexFailure）；台账读不了 = 不知道，当没有（存活探测照常兜底） */
function failureOf(ledger: LedgerReader, agent: string): CodexFailureSeen | undefined {
  const db = ledger.get();
  if (!db) return undefined;
  try {
    const f = codexFailure(db, agent)?.failure;
    return f && (f.kind === "quota" || f.kind === "auth") ? { kind: f.kind, askId: f.key, message: f.message.slice(0, 200) } : undefined;
  } catch (e) {
    console.error(`[lend] 读 ${agent} 的 Codex 卡失败：${(e as Error).message}`);
    return undefined;
  }
}

/** pass 里 lend 这一步：每轮开一次 journal，跑完关（journal 是 WAL，lend submit 可以同时写） */
export const lendStep = (ledger: LedgerReader) => async (active: () => void, lease?: SchedulerLease) => {
  active(); // 打开 journal 会建目录 / 迁移：失租就连打开都不做
  const journal = openLendJournal();
  guardJournalWrites(journal, active);
  try { return await (await import("./lend-loop.js")).lendTick(lendDeps(journal, ledger, active, lease)); } finally { journal.close(); }
};
