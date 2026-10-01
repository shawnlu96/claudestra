/**
 * i28-W7 进程内双实例 lab（规格例外：本卡独有的夹具文件，不进 fileGlobs）。A = 借入方：真台账（tests/scheduler-auto-helpers.ts 的临时库）
 * + 真调度 tick（schedulerAutoTick，scheduler.json 带 remote.reviewFirst）+ 真推送循环（lend-dispatch.ts createPushLoop）+ 真 `ledger lend-*` CLI；
 * bridge 那一层只照 bridge/local-api/lend.ts 把 CLI 结果映射成 HTTP 状态（旧 A = hello / beat / ask 回 404）。
 * B = 出借方：真 lend 循环（lend-loop.ts，tests/lend-harness.ts 的假依赖之上换成文件 journal + 文件 lend.json），收单走真 admitOrders，
 * 起 worker 照 lend-deps.ts：lendModelArgs 组参数 → lendCreateDenied 最终闸口；worker 交结论走真 routeLendTool（W4 的 MCP 路由）。
 * 回执由 A 的实例钥匙真签、B 真验。两边共用 A 的时钟（手拨）；每个 pass = 5 秒。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallerIdentity } from "../src/lib/caller-identity.js";
import { instanceKeySync, signPurpose, verifyPurpose } from "../src/lib/instance-key.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { pushCandidates } from "../src/lib/ledger-lend-peers.js";
import { pushTtlDue } from "../src/lib/ledger-lend-peers-ttl.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { readLend, type BorrowEntry, type LendEntry } from "../src/lib/lend-config.js";
import { createPushLoop, type TickReport } from "../src/lib/lend-dispatch.js";
import { LEND_ORDER_ENV, lendCreateDenied, lendModelArgs } from "../src/lib/lend-grant-spawn.js";
import { admitOrders } from "../src/lib/lend-inbox.js";
import { getOrder, openLendJournal, type LendRow } from "../src/lib/lend-journal.js";
import { receiptOf, type LendReceipt } from "../src/lib/lend-receipts.js";
import { lendTick, type LoopDeps } from "../src/lib/lend-loop.js";
import { routeLendTool, type LendToolDeps } from "../src/lib/lend-tools.js";
import { LEND_STATUS, parseLendRequest, type LendEndpoint } from "../src/lib/lend-wire.js";
import { LEND_V2_STATUS } from "../src/lib/lend-wire-v2.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";
import { ENTRY, FP, harness } from "./lend-harness.js";

/** A 给 B 记的 peer 名；B 给 A 记的名字是 harness 的 team-a */
export const MATE = "mate";
const REPO = "o/r";
export const MODEL = "gpt-6-astra";
export const EFFORT = "xhigh";
const P = "p";
export { H1 };

const CLI: Record<string, string> = { poll: "lend-poll", claim: "lend-claim", lease: "lend-lease", result: "lend-write", hello: "lend-hello", beat: "lend-beat" };
const STATUS: Record<string, number> = { ...LEND_STATUS, ...LEND_V2_STATUS };
const V2_ONLY = new Set(["hello", "beat", "ask"]);

interface Wire { op: string; body: Record<string, unknown>; status: number; answer: unknown }
interface Spawned { name: string; order: string; args: string[] }

export interface LabOpts {
  /** B 授权里的 Codex 名额（缺省 2） */
  slots?: number;
  /** A 的 borrow.maxOpen（缺省 3） */
  maxOpen?: number;
  /** 旧 A：没有 hello / beat / ask 路由（404）；函数 = 可以中途切换 */
  oldA?: () => boolean;
  /** 旧 B：不讲 v2（不发 hello / beat，只轮询、逐单续租） */
  oldB?: boolean;
  /** scheduler.json 的 remote（缺省 balance + reviewFirst [mate]） */
  remote?: RemotePolicy | null;
}

export async function lab(o: LabOpts = {}) {
  const f = autoFixture();
  f.advance(Date.parse(ENTRY.grantedAt!)); // A 的时钟拨到 harness 授权的签发时刻（授权 6 天后到期）
  const now = () => f.tickDeps.now();
  const dir = mkdtempSync(join(tmpdir(), "lend-lab-"));
  const spec = join(dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  f.db.run("UPDATE tasks SET spec = ?, pr = 'https://github.com/o/r/pull/7' WHERE id = 'T1'", [spec]);

  // ── A：借入方 ────────────────────────────────────────────────────────────────
  const aKey = instanceKeySync(mkdtempSync(join(dir, "a-key-")))!;
  const reports = join(dir, "a-reports");
  mkdirSync(reports);
  const borrow: BorrowEntry[] = [{ peer: MATE, projects: [P], roles: ["review"], maxOpen: o.maxOpen ?? 3 }];
  const remote = o.remote === undefined ? { mode: "balance" as const, roles: ["review" as const], poolTimeoutMin: 15, reviewFirst: [MATE] } : o.remote;
  const policy = { maxActiveWorkers: 2, ...(remote ? { remote } : {}) };
  const pmNotices: string[] = [];
  const lendDeps = {
    borrow: async () => borrow, notifyPm: async (_p: string, text: string) => void pmNotices.push(text), schedulerPolicy: () => policy,
    result: { reportDir: () => reports, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, aKey),
      peerFp: async () => FP, remoteHead: async () => ({ ok: true as const, head: H1 }) },
  };
  const aCli = (actor: string, ...args: string[]) => f.cliWith({ lend: lendDeps }, actor, ...args) as Promise<Record<string, any>>;
  const aTickDeps = { ...f.tickDeps, manager: (...a: string[]) => aCli("scheduler", ...a.slice(1)), borrow: async () => borrow };
  const aTick = async () => {
    const r = await schedulerAutoTick(f.db, { [P]: policy }, aTickDeps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };

  /** 网络故障开关：bOffline = B 和 A 之间整条断（两个方向都不通）；dropAnswers = 下一次 result 请求 A 入账了、应答丢了 */
  const net = { bOffline: false, dropResultAnswers: 0 };
  const wire: Wire[] = [];
  const oldA = o.oldA ?? (() => false);
  /** A 的 bridge：local-api/lend.ts 那层映射；旧 A 没有 v2 路由 → 404 */
  const aBridge = async (_peer: string, op: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> => {
    if (net.bOffline) throw new Error("网络断了");
    let out: { status: number; body: unknown };
    if (V2_ONLY.has(op) && oldA()) out = { status: 404, body: { ok: false, error: "not found" } };
    else {
      const r = await aCli("owner", CLI[op], "--", MATE, JSON.stringify(body));
      const code = (r.current?.lend ?? r.code) as string;
      const { ok: _ok, notified: _n, ...rest } = r;
      out = r.ok ? { status: 200, body: { ok: true, ...rest } } : { status: STATUS[code] ?? 500, body: { ok: false, code, error: String(r.error ?? code) } };
    }
    wire.push({ op, body, status: out.status, answer: out.body });
    if (op === "result" && net.dropResultAnswers > 0) {
      net.dropResultAnswers--;
      throw new Error("应答在路上丢了（A 已处理）");
    }
    return out;
  };

  // ── B：出借方 ────────────────────────────────────────────────────────────────
  const journalPath = join(dir, "b-journal.sqlite");
  const lendPath = join(dir, "b-lend.json");
  const entry: LendEntry = { ...ENTRY, families: { codex: o.slots ?? 2 }, repos: [REPO], codexModel: MODEL, codexEffort: EFFORT };
  const grant = (lend: LendEntry[]) => writeFileSync(lendPath, JSON.stringify({ version: 2, enabled: true, lend, borrow: [] }));
  grant([entry]);
  const registry = new Map<string, { sessionId: string; cwd: string }>();
  const spawned: Spawned[] = [];
  const refusedSpawns: { name: string; why: string }[] = [];
  const killed: string[] = [];
  const firstOrders: string[] = [];
  const receipts: LendReceipt[] = [];
  const bLog: string[] = [];
  /** 测试钩子：父进程组好 --model / --effort 之后、manager create 最终闸口之前（场景 4：这段工夫里出借方改了授权） */
  const hooks = { beforeCreateGate: null as (() => void) | null };
  let db = openLendJournal(journalPath);
  let bootN = 0;

  const worker: LoopDeps["worker"] = {
    find: (n) => registry.get(n),
    create: async (name, cwd, _purpose, gate, order) => {
      const denied = await gate();
      if (denied) return { ok: false, error: denied };
      const args = lendModelArgs(db, order, lendPath); // lend-deps.ts：gate 之后、create 之前现读 lend.json
      hooks.beforeCreateGate?.();
      hooks.beforeCreateGate = null;
      const pick = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
      const no = lendCreateDenied(name, { env: { [LEND_ORDER_ENV]: order }, journal: journalPath, lendPath, now: now(), choice: { model: pick("--model"), effort: pick("--effort") } });
      if (no) return (refusedSpawns.push({ name, why: no }), { ok: false, error: no });
      spawned.push({ name, order, args });
      registry.set(name, { sessionId: `thr-${name}`, cwd });
      return { ok: true };
    },
    send: async (_n, _s, text) => (firstOrders.push(text), { ok: true, messageId: `m${firstOrders.length}` }),
    kill: async (n) => (killed.push(n), registry.delete(n), { ok: true }),
    alive: async (n) => (registry.has(n) ? "running" : "no_window"),
  };

  /** B 的调度服务（一次启动）：harness 的假依赖换成文件 journal / lend.json / 本 lab 的 worker 与 A；重启 = 再调一次（registry 是 tmux，跟着留下） */
  function bootB(): LoopDeps {
    const h = harness();
    const boot = `boot-lab-${String(++bootN).padStart(4, "0")}`;
    return Object.assign(h.d, {
      db, now, call: aBridge, readLend: () => readLend(lendPath), worker, log: (m: string) => void bLog.push(m),
      v2: o.oldB ? undefined : { boot, call: aBridge },
      clone: async (i: { orderId: string }) => {
        const d = join(dir, "b-work", i.orderId.replace(/[^\w]/g, "_"));
        mkdirSync(d, { recursive: true });
        return { ok: true as const, dir: d };
      },
      verifyReceipt: async (_peer: string, r: { orderId: string; sha256: string; eventSeq: number; taskId: string; sig: string }) =>
        verifyPurpose(aKey.publicKey, RECEIPT_PURPOSE, [r.orderId, r.sha256, String(r.eventSeq), r.taskId], r.sig),
      writeReceipt: async (row: LendRow) => void receipts.push(receiptOf(row, "未知", now())), // 生产同一个函数，用量在 lab 里读不到
    });
  }
  let bd = bootB();
  const restartB = () => {
    db.close();
    db = openLendJournal(journalPath);
    bd = bootB();
  };

  // A 的推送循环：真 createPushLoop，send = B 的收单闸（manager lend inbox 里调的同一个 admitOrders），应答经 `ledger lend-pushed` 入账
  const pushes: TickReport[] = [];
  const pushLoop = createPushLoop({
    now, candidates: (n) => pushCandidates(f.db, n), problem: async () => null, log: () => {},
    send: async (_peer, body) => {
      if (net.bOffline) throw new Error("推不过去：B 掉线");
      const got = await admitOrders(bd, { peer: "team-a", fp: FP }, body.orders, "push");
      return { status: 200, body: { ok: true, v: 1, ...got }, e2e: true };
    },
    record: async (peer, answer) => (await aCli("owner", "lend-pushed", "--", peer, JSON.stringify(answer))).ok === true,
    ttlDue: (n) => pushTtlDue(f.db, n).length > 0,
    sweep: async () => void (await aCli("owner", "lend-sweep")),
  });

  /** 一个 pass（5 秒）：B 的调度服务一轮 → A 的调度一轮 → A 的推送循环一轮 → A 的 lend-sweep（租约过期 / 推送 TTL） */
  async function pass(opts: { a?: boolean } = {}) {
    await lendTick(bd);
    if (opts.a !== false) await aTick();
    const rep = await pushLoop.tick();
    if (rep) pushes.push(rep);
    await aCli("owner", "lend-sweep");
    f.advance(5_000);
  }
  const passes = async (n: number, opts: { a?: boolean } = {}) => { for (let i = 0; i < n; i++) await pass(opts); };

  /** worker 经 MCP（W4 routeLendTool）交审查结论：报告写进自己的工作副本，身份 = 起它时 registry 记的会话 */
  async function workerSubmit(orderId: string, over: Record<string, unknown> = {}, who: Partial<CallerIdentity> = {}) {
    const row = getOrder(db, orderId)!;
    writeFileSync(join(row.dir!, "report.md"), "# 审查报告\n没有问题。");
    const identity: CallerIdentity = { agent: row.agent, sessionId: row.sessionId, family: "codex", verified: true, ...who };
    const args = { v: 1, orderId, head: H1, verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "report.md", ...over };
    const deps: LendToolDeps = { db, call: aBridge, log: (m) => void bLog.push(m), now };
    return routeLendTool("submit_verdict", identity, args, deps) as Promise<Record<string, any>>;
  }

  /** T1 走到 review（自动卡：作者 Claude，审查要 Codex） */
  async function toReview() {
    await toBuild(f);
    await f.tick();
    await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  }

  /** PM 手挂一张已交付的卡（场景 2 的另两张待审） */
  async function handOffer(id: string): Promise<string> {
    const s = join(dir, `${id}.md`);
    writeFileSync(s, `规格：${id}`);
    createTask(f.db, f.at("owner"), { project: P, id, title: id, kind: "code", spec: s });
    f.db.run(`UPDATE tasks SET stage = 'review', headSHA = '${H1}', round = 1 WHERE id = '${id}'`);
    const r = await aCli("pm", "lend-offer", id, "--peer", MATE, "--repo", REPO, "--pr", "7");
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.orderId as string;
  }

  /** B 发给 A 的每个 v1 正文都过 A 的 v1 严格解析器（金样本之外的流程内核对） */
  const v1Strict = () => wire.filter((w) => !V2_ONLY.has(w.op)).map((w) => [w.op, parseLendRequest(w.op as LendEndpoint, w.body).ok]);

  /** 证据摘要（LEND_LAB_TRACE=1 才打印，docs/team/lend-trial-evidence.md 贴的就是它）：mark 之后 A 台账里和出借有关的事件、A 的出借单、
   * B journal、B 收据、线上请求（op:状态码，连续相同的合并） */
  let mark = 0;
  const markNow = () => void (mark = listEvents(f.db, { project: P }).at(-1)?.seq ?? 0);
  function report(scene: string) {
    if (!process.env.LEND_LAB_TRACE) return;
    const lendish = (e: { kind: string; data: Record<string, unknown> }) =>
      ["review", "note", "step", "stage"].includes(e.kind) || (e.kind === "scheduler" && e.data.op !== "settle");
    const what = (e: { kind: string; text: string; data: Record<string, unknown> }) =>
      e.kind === "step" ? `${e.data.op} ${e.data.step} 第 ${e.data.round} 轮 → ${e.data.executor}` : e.text;
    const ev = listEvents(f.db, { project: P }).filter((e) => e.seq > mark && lendish(e)).map((e) => `  A#${e.seq} ${e.kind} ${e.target} ${e.actor}：${what(e)}`);
    const tasks = [...new Set(listEvents(f.db, { project: P }).map((e) => e.target))];
    const ao = tasks.flatMap((t) => listLendOrders(f.db, t)).map((x) => `  A 单 ${x.orderId} ${x.status}${x.reason ? `（${x.reason}）` : ""}`);
    const bj = (db.query("SELECT orderId, state, reason FROM lend_orders ORDER BY createdAt").all() as { orderId: string; state: string; reason: string | null }[])
      .map((r) => `  B journal ${r.orderId} ${r.state}${r.reason ? `（${r.reason}）` : ""}`);
    const rc = receipts.map((r) => `  B 收据 ${JSON.stringify({ orderId: r.orderId, taskId: r.taskId, step: r.step, head: r.head?.slice(0, 8), family: r.family,
      outcome: r.outcome, reason: r.reason, acked: !!r.ackSig })}`);
    const ops: string[] = [];
    for (const w of wire) {
      const k = `${w.op === "lease" ? `lease:${w.body.action}` : w.op}:${w.status}`;
      const m = ops.at(-1)?.match(/^(.*?)(?: ×(\d+))?$/);
      if (m && m[1] === k) ops[ops.length - 1] = `${k} ×${Number(m[2] ?? 1) + 1}`;
      else ops.push(k);
    }
    console.log([`=== ${scene} ===`, ...ev.map((l) => l.slice(0, 240)), ...ao, ...bj, ...rc, `  线上：${ops.join(" → ")}`].join("\n"));
  }

  return {
    report, markNow, f, aCli, aBridge, aTick, now, net, wire, pass, passes, pushes, pmNotices, borrow, policy,
    get b() { return bd; }, get db() { return db; }, restartB, grant, entry, registry, spawned, refusedSpawns, killed, firstOrders, receipts, bLog, hooks,
    workerSubmit, toReview, handOffer, v1Strict,
    advance: (ms: number) => f.advance(ms),
    bState: (id: string) => getOrder(db, id)?.state,
    orders: (task = "T1") => listLendOrders(f.db, task),
    reviews: (task = "T1") => listEvents(f.db, { project: P, target: task }).filter((e) => e.kind === "review"),
    ops: () => wire.map((w) => (w.op === "lease" ? `lease:${w.body.action}` : w.op)),
  };
}

export type Lab = Awaited<ReturnType<typeof lab>>;
