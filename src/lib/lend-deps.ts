/**
 * lend 循环的生产接线（LoopDeps，lend-loop.ts）：出站经 `manager lend call`（只走 E2E），台账写经 `ledger lend-inform / lend-ask`（调度服务身份），
 * worker 经 `manager create / kill`（agent-lend-* 名字 → runtimes/clean-env.ts 的白名单环境），首条派单经 bridge 的 route_to_agent（带会话核对）。
 * 每个外部效果都套 whileOwned：发起前、结束后各核一次服务是否仍持有单实例锁与维护租约（同 E2a），bridge 帧在发出的同一段同步代码里再核一次。
 * 写单（i28-R6）：本机指纹按实例公钥算，推送 / 开 PR 经 lend-push.ts（出借人自己的 git / gh 登录），派单尾注换成「提交后 lend submit 交摘要」。
 * 协议 v2（i28-W3）：hello / beat 走同一个 `manager lend call`，单次出站 15 秒封顶（子进程超时强杀），挂死的对方拖不住这一轮；
 * 输出摘要从 worker 的 Codex 会话文件末尾读（lend-beat.ts 负责脱敏与截断）。
 * lend 档 MCP（i28-W4）：审查单的首条派单只是一句唤醒，订单由 worker 自己 take_review 领、submit_verdict 交（bridge/lend-tools.ts），
 * 不再把整份订单塞进会话；lend-drive 照旧在发之前同步重读授权，这里在发送接线上把正文换成唤醒行。写单不变：整份派单进会话，交付走 lend submit。
 */
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { bridgeSend } from "./bridge-client.js";
import { resolveBunPath } from "./bun-path.js";
import { instanceKeySync, keyFingerprint, verifyPurpose } from "./instance-key.js";
import { LEND_ROOT, prepareClone, removeOrderDir } from "./lend-clone.js";
import { sweepTrash } from "./lend-trash.js";
import { reapOrder, reapOrphans, systemProcPorts } from "./lend-proc-reap.js";
import { readLend } from "./lend-config.js";
import { isWriteStep } from "./lend-git.js";
import { withPaneArchive } from "./lend-pane-archive.js";
import { ensurePr, probePush, pushWork } from "./lend-push.js";
import { archiveClaudeWorkerName } from "./lend-claude-worker-archive.js";
import { archiveEndedWorker } from "./lend-session-archive.js";
import { claudeWorkerSessionPath } from "./lend-claude-worker-session.js";
import { claudeTrashDir, removeClaudeWorkerConfig } from "./lend-claude-worker.js";
import { lendRuntimeArgs, removeClaudeOrderConfig } from "./lend-claude-worker-routing.js";
import { LEND_ORDER_ENV, lendModelArgs } from "./lend-grant-spawn.js";
import { getOrder, guardJournalWrites, LEND_JOURNAL_PATH, liveOrders, openLendJournal, orderOf, unsettledOrders, type LendRow } from "./lend-journal.js";
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
import { codexFailure, sendVia } from "./scheduler-auto-ports.js";
import { encodeLease, SCHEDULER_LEASE_ENV, type SchedulerLease } from "./scheduler-lease-env.js";
import { whileOwned } from "./scheduler-maintenance.js";
import { schedulerManagerWith } from "./scheduler-service.js";
import { probeAcpWorker } from "./worker-liveness.js";
import { arbiterFooter, arbiterFullMessage, lendSubmitCmd } from "./lend-arbiter-submit.js";
import { readInventoryQuota } from "./ai-quota.js";
import { newBoot, owedPeers } from "./lend-hello.js";
import { findSessionJsonlBySessionId, translateSessionLine } from "./session-source.js";
import { quotaViewOf, type LendWorkerFailure, confirmedTurnFailure } from "./lend-health.js";
import { keepLendEvidence } from "./lend-evidence.js";
import { listAsks } from "./ledger-asks.js";
import { turnFailureDoubt } from "./lend-turn-failure.js";
import { readWeekQuota } from "./quota-week.js";
import { lendWorkerFailureOf } from "./lend-claude-pause-worker.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;

/** 建 / 杀 agent 不用调度服务身份（那个身份只许跑台账的调度命令），同 scheduler-auto-deps 的 plainManager：也带服务租约，服务停了排队中的建 / 杀什么都不做 */
const plainManager = (lease: SchedulerLease | undefined, extra: Record<string, string> = {}): Manager => (...args) => runManagerProcess(args, {
  bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`, env: { ...process.env, DISCORD_CHANNEL_ID: "", [SCHEDULER_LEASE_ENV]: encodeLease(lease), ...extra },
  timeoutMs: 180_000 });

/** 对 A 的单次出站上限：超时就强杀 `manager lend call`，按传输失败处理（本轮跳过这个 peer 的其余出站） */
const OUTBOUND_MS = 15_000;
const outboundManager = (lease: SchedulerLease | undefined): Manager => (...args) => runManagerProcess(args, {
  bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`, timeoutMs: OUTBOUND_MS,
  env: { ...process.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "1", [SCHEDULER_LEASE_ENV]: encodeLease(lease) } });

/** 本进程的 hello 启动号：调度服务重启就换一个（A 按 boot + seq 防回滚） */
const BOOT = newBoot();

const LEND_PROJECT = "lend";

/**
 * 要不要进 pass 跑 lend 这一步：出借开着，或 journal 里还有没跑完的单、没做完的收尾（lend off 之后在跑的单也要跑完、续租、自停，
 * 终态之后没写成的收据 / 没发出的通知也要补上：收尾不看出借开关），或者还欠哪个 A 一句收回的 hello
 */
export async function lendWanted(journal = LEND_JOURNAL_PATH, lendPath?: string): Promise<boolean> {
  sweepTrashOnce(); // 放这里不放 lendStep：出借关着、没有在跑的单时 lendStep 永远不跑，上次没删完的残留就一直留着
  takeHandoff()?.close(); // 上一轮 pass 没走到 lend 步（前面抛了）：留着的连接这里关
  const read = await readLend(lendPath);
  if (read.status === "ok" && read.file.enabled) return true;
  if (!existsSync(journal)) return false;
  const db = openLendJournal(journal);
  let wanted = false;
  // 收回之后还欠 A 一句 grant:null（最近一次成功的 hello 带着授权、没过 180 秒）：总开关关了也要跑到说完
  try { return (wanted = liveOrders(db).length > 0 || unsettledOrders(db).length > 0 || owedPeers(db, Date.now()).length > 0); } finally {
    if (wanted && journal === LEND_JOURNAL_PATH) handoff = db; else db.close();
  }
}

/** lendWanted 判「要跑」时开着的 journal 连接，交给同一轮的 lendStep 接着用：一轮只开一次（每次开都要跑迁移检查、关时 checkpoint） */
let handoff: Database | null = null;
const takeHandoff = (): Database | null => { const db = handoff; handoff = null; return db; };

/** 出借 worker 固定归到 lend 项目：不按目录落进别的项目，项目上下文里也就不会带上 B 自己的项目花名册 */
async function ensureLendProject(m: Manager): Promise<void> {
  if ((await readProjects()).projects.some((p) => p.id === LEND_PROJECT)) return;
  const r = await m("project-add", LEND_PROJECT, "--dirs", join(LEND_ROOT, "work"), "--name", "出借");
  if (r.ok !== true && !String(r.error ?? "").includes("已存在")) throw new Error(`建 lend 项目失败：${String(r.error ?? "")}`);
}

const submitCmd = (row: LendRow): string => lendSubmitCmd(row.orderId);

/** 审查单的首条派单（整条就是它，不带订单原文）：领单、交结论都走 lend 档 MCP，CLI 只在工具调不通时兜底 */
const reviewWake = (row: LendRow): string[] => [
  `你是一次性的出借 worker，有一张审查单（单号 ${row.orderId}）；当前目录是这张单的独立 clone，别动别的目录。`,
  "1. 先调 claudestra 的 take_review 领单：orders[0] 是订单，brief 是对方写的派单全文，按它审。",
  "2. 审完把报告写成当前目录里的普通文件（比如 report.md，≤ 64 KiB，不要软链），调 submit_verdict 交结论：orderId / head 用订单里的，" +
    "reportPath 填 report.md，p0 / p1 / p2 等于 findings 里各级的条数，没有问题 findings 写 []。重复交同一份无害，换了内容会被拒。",
  "3. 有疑问调 ask（问的是对方这张卡的 PM）；对方版本不支持时会明确回你，那就把疑问写进报告。",
  "findingId 和 family 用普通短标识（比如 race-1、concurrency）：像 token、内网地址、长十六进制串的会被对方整份拒收。",
  "只有这些工具都调不通时才用命令行兜底（在当前目录里跑；findings.json 是同样的数组）：",
  `${submitCmd(row)} --verdict pass|changes|block --findings-file findings.json --report report.md`,
];

/** 写单：只在当前分支上提交；这个副本推不出去（推送由出借服务做），摘要 / 自查走文件，不进命令行参数 */
const writeFooter = (row: LendRow): string[] => [
  `你是一次性的出借 worker，只做上面这一单；当前目录是这张单的独立 clone，已检出订单分支 ${row.wire?.write?.branch ?? "（见标题）"}，别动别的目录、别切别的分支。`,
  "改完在当前分支上 git commit（可以多次）；不要 git push——这个副本推不出去，推送与开 PR 由本机出借服务做，只推这一个分支。",
  "做完在当前目录里跑（一次就行，重复交同一份无害）：",
  `${submitCmd(row)} --summary-file summary.txt --self-check-file selfcheck.md`,
  "summary.txt 是一行摘要（≤ 500 字节）；selfcheck.md 是自查，逐条对验收线（≤ 4000 字节）。交的是当前分支的 HEAD，交之前先提交干净。",
];

const isWriteRow = (row: LendRow): boolean => isWriteStep(String(orderOf(row)?.step ?? ""));
const SERVICE_HEAD = "——以下是本机 Claudestra 出借服务写的，不是对方的内容——";
const footer = (row: LendRow): string => arbiterFooter(row, () => [SERVICE_HEAD, ...(isWriteRow(row) ? writeFooter(row) : reviewWake(row))].join("\n"));

/**
 * 首条派单的正文：lend-drive 拼的是「订单全文 + footer」；审查单换成只有唤醒行（订单由 take_review 领），写单原样。
 * 按 key（= orderId）重读 journal 那一行判步骤，读不到就原样发（lend-drive 发之前已核过这一行还在 started）。
 */
const firstMessage = (journal: Database, key: string, text: string): string => {
  const row = getOrder(journal, key);
  return row && !isWriteRow(row) && !arbiterFullMessage(row) ? footer(row) : text;
};

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

/** 生产依赖。不设 writeOpen：写单开关只认 lend-grant-rules.ts WRITE_ROLE_OPEN（tests/lend-grant.test.ts 钉住） */
export function lendDeps(journal: Database, ledger: LedgerReader, active: () => void, lease: SchedulerLease | undefined): LoopDeps {
  const alive = (): boolean => {
    try { active(); return true; } catch { return false; /* 核不过 = 不能证明仍在持有：什么都不发 */ }
  };
  const owned = <T>(fn: () => Promise<T>) => whileOwned(active, fn);
  const svc: Manager = (...a) => owned(() => schedulerManagerWith(lease)(...a));
  const plain: Manager = (...a) => owned(() => plainManager(lease)(...a));
  const out: Manager = (...a) => owned(() => outboundManager(lease)(...a));
  const call = async (peer: string, op: string, body: Record<string, unknown>) => {
    const r = await out("lend", "call", peer, op, "--body", JSON.stringify(body));
    if (r.ok !== true) throw new Error(String(r.error ?? "manager lend call 失败"));
    return { status: Number(r.status), body: r.body };
  };
  /** 读失败一律 unknown（worker-liveness.ts）；服务停止 / 失租照样往外抛，不被吞成 unknown */
  const probe = (name: string) => owned(() => probeAcpWorker(name));
  const registryRow = (name: string) => readRegistryAgentsSync().find((a) => a.name === name);
  const send = sendVia(registryRow, alive);
  const lendLog = (m: string) => console.error(`[lend] ${m}`);
  const procPorts = systemProcPorts();
  return {
    db: journal, now: () => Date.now(), call: call as LendCall, env: process.env, footer, verifyReceipt,
    v2: { call, boot: BOOT, excerpt: (row) => workerExcerpt(row), quota: () => readWeekQuota() },
    readLend: () => readLend(), context: () => readLendContext(), peers: async () => (await readPeers()).httpPeers ?? [],
    log: lendLog,
    notify: async (p) => {
      const r = await svc("ledger", "lend-inform", "--params", JSON.stringify(p));
      return r.ok === true && r.notified === true ? { ok: true } : { ok: false, error: String(r.error ?? r.why ?? "bridge 没收下通知") };
    },
    retireAsk: async (askId) => {
      const r = await svc("ledger", "lend-ask", "--retire", askId);
      return r.ok === true ? { ok: true } : { ok: false, error: String(r.error ?? "ledger lend-ask --retire 失败") };
    },
    failure: (agent) => lendWorkerFailureOf(journal, agent, (row) => failureOf(ledger, agent, row)),
    keepEvidence: (row, why) => { active(); return keepLendEvidence(row, why); },
    archiveSessions: (row) => owned(() => archiveEndedWorker(row, (m) => console.error(`[lend] ${m}`))),
    closeAsks: async (agent) => {
      const r = await svc("ledger", "lend-close-asks", "--agent", agent);
      return r.ok === true ? { ok: true } : { ok: false, error: String(r.error ?? "ledger lend-close-asks 失败") };
    },
    codexQuota: async () => quotaViewOf((await readInventoryQuota()).codex),
    clone: (input) => owned(() => prepareClone(input)),
    removeDir: (orderId) => {
      active(); removeClaudeOrderConfig(journal, orderId); removeOrderDir(orderId); removeOrderDir(orderId, LEND_ROOT, "push");
    },
    reapOrder: (orderId) => { active(); return reapOrder(orderId, { ports: procPorts, log: lendLog, active }); },
    reapOrphans: () => { active(); return reapOrphans(journal, { now: Date.now(), ports: procPorts, log: lendLog, active }); },
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
      create: async (name, dir, purpose, gate, order) => {
        await ensureLendProject(plain);
        const denied = await gate(); // 建项目要拿 manager 写锁：这段工夫里收回了就不起（之后到起窗口之间由 manager create 按订单号再核，lend-grant-spawn.ts）
        if (denied) return { ok: false, error: denied };
        const create: Manager = (...a) => owned(() => plainManager(lease, { [LEND_ORDER_ENV]: order })(...a));
        const r = await create("create", name, dir, "--purpose", purpose, "--project", LEND_PROJECT, ...lendRuntimeArgs(journal, order), ...lendModelArgs(journal, order));
        return r.ok === true ? { ok: true } : { ok: false, error: String(r.error ?? "manager create 失败") };
      },
      send: (name, sessionId, text, key) => owned(() => send(name, sessionId, firstMessage(journal, key, text), key)),
      kill: withPaneArchive(async (name) => { // kill 前先存 pane 现场（lend-pane-archive.ts），存档失败不挡 kill
        await archiveClaudeWorkerName(name);
        const r = await plain("kill", name);
        const still = await probe(name);
        if (still === "no_window") { removeClaudeWorkerConfig(name); return { ok: true }; }
        return { ok: false, reason: still === "unknown" ? "读不到 tmux 窗口 / 进程，没法确认已退出" : `kill 后窗口还在（${String(r.error ?? "")}）` };
      }),
      alive: probe,
    },
  };
}

const TAIL_BYTES = 64 * 1024;
const sessionFiles = new Map<string, string>();

/** worker 最近一段 assistant 文字（Codex 会话文件末尾 64 KiB 里的最后一条）与文件 mtime；还没有会话 / 找不到文件 = null（摘要用空串） */
async function workerExcerpt(row: LendRow): Promise<{ text: string; at: number } | null> {
  if (!row.sessionId) return null;
  const path = sessionFiles.get(row.sessionId) ?? (row.family === "claude"
    ? claudeWorkerSessionPath(row.sessionId, row.agent ?? undefined) : findSessionJsonlBySessionId("codex", row.sessionId));
  if (!path) return null;
  sessionFiles.set(row.sessionId, path);
  const st = await stat(path);
  const fh = await open(path, "r");
  try {
    const len = Math.min(st.size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, st.size - len);
    const lines = buf.toString("utf8").split("\n");
    if (st.size > len) lines.shift(); // 第一行多半被截断
    for (const line of lines.reverse()) {
      const rec = translateSessionLine(row.family === "claude" ? "claude-code" : "codex", line);
      const content = rec?.type === "assistant" ? rec.message?.content : null;
      const text = Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => String(c.text ?? "")).join("\n") : "";
      if (text.trim()) return { text, at: st.mtimeMs };
    }
    return { text: "", at: st.mtimeMs };
  } finally { await fh.close(); }
}

/** 已经记过「不自动停单」的卡：每 30 秒一轮，同一张卡只记一次（进程内，重启再记一次无妨） */
const doubted = new Set<string>();

/**
 * bridge 为这个 worker 开的最新一张 Codex 卡；台账读不了 = 不知道，当没有（存活探测照常兜底）。额度 / 登录同 scheduler-auto-ports codexFailure；
 * 回合失败卡要证明是 row 这一单当前回合的（lend-turn-failure.ts），证明不了按改动前处理：交给 codexFailure，没派单可归就是没有
 */
function failureOf(ledger: LedgerReader, agent: string, row: LendRow | undefined): LendWorkerFailure | undefined {
  const db = ledger.get();
  if (!db) return undefined;
  try {
    const card = listAsks(db, { fromAgent: agent, source: "codex", states: ["open"] }).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (card?.extra.failure === "error" && row) {
      const doubt = turnFailureDoubt(card, row, (id) => findSessionJsonlBySessionId("codex", id));
      if (!doubt) return confirmedTurnFailure(card, doubt); // 原文只进本机证据，不进 reason / 回执（lend-health.ts failureReason）；带会话 / 失败时刻给 MODELXP2 类别
      if (!doubted.has(card.id)) doubted.add(card.id), console.error(`[lend] ${agent} 的回合失败卡 ${card.id} 不自动停单：${doubt}；卡留在看板上由人处理`);
    }
    const f = codexFailure(db, agent)?.failure;
    return f && (f.kind === "quota" || f.kind === "auth") ? { kind: f.kind, askId: f.key, message: f.message.slice(0, 200) } : undefined;
  } catch (e) {
    console.error(`[lend] 读 ${agent} 的 Codex 卡失败：${(e as Error).message}`);
    return undefined;
  }
}

/** 本进程第一次判 lendWanted 时清回收目录：上个进程退出时没删完的副本 / worker 配置（lend-trash.ts trashAway） */
let swept = false;
function sweepTrashOnce(): void {
  if (swept) return;
  swept = true;
  for (const trash of [join(LEND_ROOT, "trash"), claudeTrashDir()]) {
    try { sweepTrash(trash); } catch (e) { console.error(`[lend] 不清回收目录 ${trash}：${(e as Error).message}`); }
  }
}

/** pass 里 lend 这一步：每轮开一次 journal，跑完关（journal 是 WAL，lend submit 可以同时写） */
export const lendStep = (ledger: LedgerReader) => async (active: () => void, lease?: SchedulerLease) => {
  active(); // 打开 journal 会建目录 / 迁移：失租就连打开都不做
  const journal = takeHandoff() ?? openLendJournal();
  guardJournalWrites(journal, active);
  try { return await (await import("./lend-work-retention.js")).lendTickWithRetention(lendDeps(journal, ledger, active, lease), active); } finally { journal.close(); }
};
