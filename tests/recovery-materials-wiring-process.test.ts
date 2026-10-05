/**
 * dispatch-recovery-MATW 集成边界（上一轮审查 P1 integration-proof / bundle-path）：不注入 recoveryReader、不进程内调 handler。
 * 一份源码树副本（tmp/src，node_modules 软链）就是被测的「部署」。主线整合（MATWC1）：CFG 已在 main，正式位置 src/lib/recovery-policy.ts
 * 是真模块，manager 也静态导入它（RECOVERY_KEYS / observedRecent / setRecovery…）。副本里真 CFG 原样挪到同目录 recovery-policy-cfg.ts，
 * 正式位置换成薄包装：`export *` 全部真导出，只把 recoveryPolicy 包一层——把 pid + project:mechanism 记进 matw-calls.log 后原样调真函数
 * （不复制算法、不改返回）。策略经正式 CLI `ledger scheduler-recovery <p> <mode> --key materials` 写进临时状态目录的 recovery-policy.json。
 * 「未安装」只在 bun build 产物部署里制造：产物已静态打进真 CFG，挪走源码树正式位置的文件只让动态 reader 缺席；
 * 源码部署里它是静态依赖，不挪。
 * 每条 manager 命令都是一个新进程（`bun --no-env-file <src/manager.ts | dist/manager.js> ledger …`），台账是状态目录里的 sqlite 文件：
 * 一条命令一次「重启」。子进程 env 只有 testChildEnv 的最小集合 + 临时 HOME / STATE / RUNTIME / TMPDIR，bridge 指向拒连端口，
 * PATH 里的 git 是替身（ls-remote 读 tmp/remote/<branch>）。对方收到的单子取自假网络：一个 HTTP 服务照 bridge/local-api/lend.ts
 * 把 POST /api/v1/lend/<op> 转成 `ledger lend-<op> -- mate <body>` 子进程，测试按对方的身份 fetch，断言的是线上那段响应字节。
 */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MATERIALS_BLOCKED } from "../src/lib/fix-materials.js";
import { acquireLock } from "../src/lib/file-lock.js";
import { instanceKeySync, keyFingerprint, signPurpose } from "../src/lib/instance-key.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { autoFixture, H2 as AUTO_H2, P1, toBuild } from "./scheduler-auto-helpers.js";
import { testChildEnv } from "./test-env.js";

const REPO_SRC = join(import.meta.dir, "..", "src");
const P = "p", Q = "q";
const H1 = "b".repeat(40), H2 = "c".repeat(40);
const SECRET = `ghp_${"A1b2C3d4".repeat(4)}`;
const n = (s: string): string => s.normalize("NFKC");
const LABEL = n("修复材料（结构化必需项，不是审查报告原文）：");
const FULL = n("上一轮审查报告原文：\n");
const FINDINGS = [{ findingId: "race-1", family: "concurrency", severity: "P1", probe: "两进程同时写", description: "并发写丢数据" },
  { findingId: "api-2", family: "api", severity: "P2", probe: "返回值没校验", description: "调用方拿到 undefined", file: "src/lib/x.ts", line: 12 }];
const LEND_CLI: Record<string, string> = { claim: "lend-claim", result: "lend-write" };

/** 正式位置的薄包装：真 CFG 的全部导出原样转出；recoveryPolicy 记一行调用后原样交给真函数。`answer` 只给负例改写真结果。 */
const wrapperSrc = (answer = "r") => `import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { recoveryPolicy as cfg } from "./recovery-policy-cfg.ts";
export * from "./recovery-policy-cfg.ts";
export function recoveryPolicy(project, mechanism, ...rest) {
  appendFileSync(join(process.env.CLAUDESTRA_STATE_DIR, "matw-calls.log"), process.pid + " " + project + ":" + mechanism + "\\n");
  const r = cfg(project, mechanism, ...rest);
  return ${answer};
}
`;

/** A deployed source tree (optionally bundled) with the formal-location reader, its own state, fake git and fake network. */
export function deployment(opts: { bundle?: boolean; state?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "matw-proc-")));
  cpSync(REPO_SRC, join(root, "src"), { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(root, "node_modules"));
  cpSync(join(import.meta.dir, "..", "package.json"), join(root, "package.json"));
  const reader = join(root, "src", "lib", "recovery-policy.ts");
  let manager = join(root, "src", "manager.ts");
  if (opts.bundle) { // 产物按 main 原样打包（含真 CFG），之后才在源码树装包装
    const b = Bun.spawnSync([process.execPath, "build", manager, "--target=bun", "--outdir", join(root, "dist")], { stdout: "pipe", stderr: "pipe" });
    if (b.exitCode !== 0) throw new Error(`bundle failed: ${b.stderr.toString()}`);
    manager = join(root, "dist", "manager.js");
  }
  renameSync(reader, join(root, "src", "lib", "recovery-policy-cfg.ts"));
  writeFileSync(reader, wrapperSrc());
  const state = opts.state ?? join(root, "state");
  for (const d of ["home", "run", "tmp", "bin", "remote", "proj-p", "proj-q"]) mkdirSync(join(root, d), { recursive: true });
  mkdirSync(state, { recursive: true });
  // 替身 git：只答 ls-remote <url> refs/heads/<branch>，head 取 remote/<branch 的 / 换成 _>
  writeFileSync(join(root, "bin", "git"), `#!/bin/sh
[ "$1" = "ls-remote" ] || exit 2
b="\${3#refs/heads/}"; f="${join(root, "remote")}/$(printf %s "$b" | tr / _)"
[ -f "$f" ] && printf '%s\\trefs/heads/%s\\n' "$(cat "$f")" "$b"
exit 0
`);
  // 替身 gh：调度服务的修复开工探针（lib/lend-fix-start.ts）只问 api repos/<repo>/git/ref/heads/<branch>，同一份 remote/
  writeFileSync(join(root, "bin", "gh"), `#!/bin/sh
case "$2" in repos/*/git/ref/heads/*) b="\${2#repos/*/git/ref/heads/}"; f="${join(root, "remote")}/$(printf %s "$b" | tr / _)"; [ -f "$f" ] && cat "$f" && exit 0;; esac
exit 1
`);
  for (const b of ["git", "gh"]) chmodSync(join(root, "bin", b), 0o755);
  const setRemote = (branch: string, head: string) => writeFileSync(join(root, "remote", branch.replaceAll("/", "_")), head);
  setRemote("main", H1);
  const mateKey = instanceKeySync(mkdtempSync(join(root, "mate-key-")))!;
  writeFileSync(join(state, "peers.json"), JSON.stringify({ httpPeers: [{ name: "mate", publicKey: mateKey.publicKey, addedAt: "" }], pendingInvites: [] }));
  writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [P, Q].map((id) => ({ id, name: id, dirs: [join(root, `proj-${id}`)], createdAt: "" })) }));
  writeFileSync(join(state, "lend.json"), JSON.stringify({ version: 2, enabled: false, lend: [],
    borrow: [{ peer: "mate", projects: [P, Q], roles: ["review", "write"], maxOpen: 20 }] }));
  if (!existsSync(join(state, "registry.json"))) writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents: {} }));
  const env = (extra: Record<string, string> = {}) => testChildEnv({ PATH: `${join(root, "bin")}:/usr/bin:/bin`, HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
    CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(root, "run"), ...extra });
  /** One manager process: `bun --no-env-file <manager> <args>`, cwd = the deployment root; its last stdout line is the JSON result. */
  const run = async (args: string[], extra: Record<string, string> = {}): Promise<{ out: Record<string, any>; err: string; pid: number }> => {
    const proc = Bun.spawn([process.execPath, "--no-env-file", manager, ...args], { cwd: root, env: env(extra), stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    const last = out.trim().split("\n").at(-1) ?? "";
    try { return { out: JSON.parse(last), err, pid: proc.pid }; } catch { throw new Error(`manager ${args[0]} ${args[1] ?? ""}: ${out}\n${err}`); }
  };
  // 假网络：bridge/local-api/lend.ts 的映射（CLI 结果 → HTTP 状态 / body），每个请求一个 manager 进程（无频道号 = owner）
  const wire: { op: string; status: number; text: string }[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const op = new URL(req.url).pathname.match(/^\/api\/v1\/lend\/(claim|result)$/)?.[1];
    if (!op || req.method !== "POST") return new Response("not found", { status: 404 });
    const { out: r } = await run(["ledger", LEND_CLI[op], "--", "mate", await req.text()], { DISCORD_CHANNEL_ID: "" });
    const { ok: _ok, notified: _n, ...rest } = r;
    return Response.json(r.ok ? { ok: true, ...rest } : { ok: false, code: r.current?.lend ?? r.code, error: String(r.error) }, { status: r.ok ? 200 : 409 });
  } });
  /** The peer's request over the network; returns what came back on the wire. */
  const peer = async (op: "claim" | "result", body: unknown): Promise<{ status: number; text: string; json: Record<string, any> }> => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/lend/${op}`, { method: "POST", body: JSON.stringify(body) });
    const text = await res.text();
    wire.push({ op, status: res.status, text });
    return { status: res.status, text, json: JSON.parse(text) };
  };
  /** 经正式 CLI（owner 身份，独立进程）把各项目的 materials 键设成给定模式，写进临时状态目录的 recovery-policy.json */
  const policy = async (modes: Record<string, string>) => {
    for (const [project, mode] of Object.entries(modes)) {
      const { out } = await run(["ledger", "scheduler-recovery", project, mode, "--key", "materials", "--reason", "MATW 测试"], { DISCORD_CHANNEL_ID: "" });
      expect(out).toMatchObject({ ok: true, project, to: { keys: { materials: mode } } });
    }
  };
  /** 负例：正式位置的包装把真 CFG 的结果改成 `answer`（其余导出不变），fn 跑完换回 */
  const answering = async <T>(answer: string, fn: () => Promise<T>): Promise<T> => {
    writeFileSync(reader, wrapperSrc(answer));
    try { return await fn(); } finally { writeFileSync(reader, wrapperSrc()); }
  };
  const calls = (): string[] => (existsSync(join(state, "matw-calls.log")) ? readFileSync(join(state, "matw-calls.log"), "utf8").trim().split("\n") : []);
  const hideReader = () => {
    if (!opts.bundle) throw new Error("源码部署里 recovery-policy.ts 是 manager 的静态依赖，挪走就不是「未安装」而是起不来；未安装负例只在产物部署制造");
    renameSync(reader, `${reader}.away`);
  };
  const restoreReader = () => renameSync(`${reader}.away`, reader);
  return { root, state, reader, manager, mateFp: keyFingerprint(mateKey.publicKey), run, peer, wire, policy, setRemote, calls, hideReader, restoreReader, env,
    answering, close: () => server.stop(true) };
}
type Deployment = ReturnType<typeof deployment>;

const ledgerFile = (d: Deployment) => join(d.state, "ledger.sqlite");
const db = (d: Deployment) => openLedger(ledgerFile(d));

/** A card in `project` at build, offered as a write order over a real manager process, claimed and delivered by mate over the network. */
async function delivered(d: Deployment, id: string, project: string): Promise<void> {
  const spec = join(d.root, `${id}.md`);
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  const l = db(d);
  createTask(l, { actor: "owner", now: Date.now() }, { project, id, title: id, kind: "code", spec, agent: "agent-dev" } as never);
  setMeta(l, { actor: "owner", now: Date.now() }, { project, key: "pms", value: ["agent-pm"] });
  l.run("UPDATE tasks SET stage = 'build', round = 0 WHERE id = ?", [id]);
  const { out: offer } = await d.run(["ledger", "lend-offer", id, "--peer", "mate", "--repo", "o/r"]);
  expect(offer).toMatchObject({ ok: true, step: "write" });
  expect(await d.peer("claim", { v: 1, orderId: offer.orderId, worker: "agent-lend-0123456789" })).toMatchObject({ status: 200 });
  d.setRemote(offer.branch, H2);
  const w = await d.peer("result", { v: 1, orderId: offer.orderId, gen: 1, branch: offer.branch, pr: 7, session: { id: "s-1", family: "codex" },
    deliver: { v: 1, orderId: offer.orderId, head: H2, evidence: offer.branch, summary: "写好了", selfCheck: "逐条对了" } });
  expect(w).toMatchObject({ status: 200, json: { ok: true } });
}

/** delivered + one recorded review with `findings` and the report at `report` → stage fix. */
async function fixCard(d: Deployment, id: string, project: string, report: string, findings: unknown[]): Promise<string> {
  await delivered(d, id, project);
  const path = join(d.root, `${id}-r0.md`);
  writeFileSync(path, report);
  const l = db(d);
  insertEvent(l, { actor: "agent-rev", now: Date.now() }, { project, target: id, kind: "review", text: "changes", data: { round: 0, verdict: "changes", path, findings } }, true);
  l.run("UPDATE tasks SET stage = 'fix', round = 1 WHERE id = ?", [id]);
  return path;
}

/** mate claims the card's newest fix order over the network: the bytes on the wire and the parsed order. */
async function claimFix(d: Deployment, id: string) {
  const o = listLendOrders(db(d), id).findLast((x) => x.step === "fix")!;
  const r = await d.peer("claim", { v: 1, orderId: o.orderId, worker: "agent-lend-9999999999" });
  expect(r.status).toBe(200);
  return { text: r.text, inputs: r.json.order.inputs as string[], findings: r.json.order.findings as { probe: string }[] };
}
const materialsOf = (d: Deployment, id: string) => listEvents(db(d), { target: id }).filter((e) => e.kind === "note" && (e.data.lend as any)?.op === "offer" &&
  (e.data.lend as any).step === "fix").map((e) => (e.data.lend as any).materials);

describe("PM ledger lend-offer：源码部署、正式位置 reader、每条命令一个进程、对方经假网络收单", () => {
  let d: Deployment;
  beforeAll(() => { d = deployment(); });
  afterAll(() => { d.close(); closeLedger(ledgerFile(d)); });

  test("on：线上收到的单只有结构化必需项 + 来源证明，原 description 逐字；报告全文（含密钥样内容）不发、本机字节不变；reader 在 manager 进程里现读", async () => {
    await d.policy({ [P]: "on" });
    const report = `## P1\n- race-1：复现时用了 ${SECRET}\n`;
    const path = await fixCard(d, "T1", P, report, FINDINGS);
    const before = d.calls().length;
    const { out, pid } = await d.run(["ledger", "lend-offer", "T1"]);
    expect(out).toMatchObject({ ok: true, step: "fix" });
    expect(out.materialsDiag).toBeUndefined();
    expect(d.calls().slice(before)).toEqual([`${pid} ${P}:materials`]);
    const got = await claimFix(d, "T1");
    expect(got.text).not.toContain("ghp_");
    expect(got.inputs.some((s) => s.startsWith(FULL))).toBe(false);
    const material = got.inputs.find((s) => s.startsWith(LABEL))!;
    expect(material).toContain(n("问题说明（审查方原文）：\n> 并发写丢数据"));
    expect(material).toContain(n("问题说明（审查方原文）：\n> 调用方拿到 undefined"));
    expect(material).toMatch(/报告 sha256 前 12 位 [0-9a-f]{12}/);
    expect(got.findings.map((f) => f.probe)).toEqual(["两进程同时写", "返回值没校验"]);
    expect(materialsOf(d, "T1")).toEqual([expect.objectContaining({ mode: "on", items: 2, undescribed: 0, bytes: Buffer.byteLength(report) })]);
    expect(readFileSync(path, "utf8")).toBe(report);
  }, 60_000);

  test("重复挂单在另一个进程里被拒；第三个进程重挂：同一份材料、来源仍指同一审查事件，对方再经网络收到", async () => {
    await d.policy({ [P]: "on" });
    const first = listLendOrders(db(d), "T1").findLast((o) => o.step === "fix")!;
    expect((await d.run(["ledger", "lend-offer", "T1"])).out).toMatchObject({ ok: false });
    expect(listLendOrders(db(d), "T1").filter((o) => o.step === "fix")).toHaveLength(1);
    expect((await d.run(["ledger", "lend-reoffer", "T1", "--reason", "核对了材料"])).out).toMatchObject({ ok: true, step: "fix" });
    const second = listLendOrders(db(d), "T1").findLast((o) => o.step === "fix")!;
    expect(second.orderId).not.toBe(first.orderId);
    const got = await claimFix(d, "T1");
    expect(got.inputs.find((s) => s.startsWith(LABEL))).toBe(first.wire.inputs.find((s) => s.startsWith(LABEL)));
    const notes = materialsOf(d, "T1");
    expect(notes).toHaveLength(2);
    expect(notes[1].eventSeq).toBe(notes[0].eventSeq);
  }, 60_000);

  for (const mode of ["observe", "off"] as const) {
    test(`${mode}：线上仍是旧路径全文；observe 只记 would-send，off 不记`, async () => {
      await d.policy({ [P]: mode });
      const id = `T-${mode}`;
      await fixCard(d, id, P, "## P1\n- race-1：并发写丢数据\n", FINDINGS);
      expect((await d.run(["ledger", "lend-offer", id])).out).toMatchObject({ ok: true, step: "fix" });
      const got = await claimFix(d, id);
      expect(got.inputs.some((s) => s.startsWith(FULL) && s.includes(n("race-1：并发写丢数据")))).toBe(true);
      expect(got.text).not.toContain(LABEL);
      expect(materialsOf(d, id)).toEqual([mode === "observe" ? expect.objectContaining({ mode: "observe", items: 2, undescribed: 0 }) : undefined]);
    }, 60_000);
  }

  test("策略值不合法 = off：全文照发、不记材料，诊断进 stderr", async () => {
    await d.policy({ [P]: "on" });
    await fixCard(d, "T-bad", P, "## P1\n- race-1\n", FINDINGS);
    // 真 CFG 只答合法模式；不合法值由负例包装在真结果上改写 mode 制造
    const { out, err } = await d.answering(`({ ...r, mode: mechanism === "materials" ? "ON" : r.mode })`, () => d.run(["ledger", "lend-offer", "T-bad"]));
    expect(out).toMatchObject({ ok: true, step: "fix" });
    expect(err).toContain("不合法");
    expect((await claimFix(d, "T-bad")).inputs.some((s) => s.startsWith(FULL))).toBe(true);
    expect(materialsOf(d, "T-bad")).toEqual([undefined]);
  }, 60_000);

  test("真 CFG 的策略文件读坏 = off：全文照发、不记材料；修好后下一个进程又按 on", async () => {
    await d.policy({ [P]: "on" });
    const file = join(d.state, "recovery-policy.json"), good = readFileSync(file, "utf8");
    await fixCard(d, "T-corrupt", P, "## P1\n- race-1\n", FINDINGS);
    writeFileSync(file, "{坏");
    try {
      const before = d.calls().length;
      const { out, pid } = await d.run(["ledger", "lend-offer", "T-corrupt"]);
      expect(out).toMatchObject({ ok: true, step: "fix" });
      expect(d.calls().slice(before)).toEqual([`${pid} ${P}:materials`]);
      const got = await claimFix(d, "T-corrupt");
      expect(got.inputs.some((s) => s.startsWith(FULL))).toBe(true);
      expect(got.text).not.toContain(LABEL);
      expect(materialsOf(d, "T-corrupt")).toEqual([undefined]);
    } finally { writeFileSync(file, good); }
    await fixCard(d, "T-fixed", P, "## P1\n- race-1\n", FINDINGS);
    expect((await d.run(["ledger", "lend-offer", "T-fixed"])).out).toMatchObject({ ok: true, step: "fix" });
    expect((await claimFix(d, "T-fixed")).inputs.some((s) => s.startsWith(LABEL))).toBe(true);
  }, 60_000);

  test("缺真正 description：on 也不拿 probe 顶，全文 fallback，记 undescribed", async () => {
    await d.policy({ [P]: "on" });
    await fixCard(d, "T-nodesc", P, "## P1\n- race-1：并发写丢数据\n", FINDINGS.map(({ description: _d, ...f }) => f));
    expect((await d.run(["ledger", "lend-offer", "T-nodesc"])).out).toMatchObject({ ok: true });
    const got = await claimFix(d, "T-nodesc");
    expect(got.inputs.some((s) => s.startsWith(FULL))).toBe(true);
    expect(got.text).not.toContain(LABEL);
    expect(materialsOf(d, "T-nodesc")).toEqual([expect.objectContaining({ mode: "on", fallback: "undescribed", undescribed: 2 })]);
  }, 60_000);

  test("敏感的必需 description：on 整单过外发闸被拒，不出修复单、不改发全文", async () => {
    await d.policy({ [P]: "on" });
    const path = await fixCard(d, "T-secret", P, "## P1\n- race-1\n", [{ ...FINDINGS[0], description: `复现：curl -H 'Authorization: Bearer ${SECRET}'` }]);
    const { out } = await d.run(["ledger", "lend-offer", "T-secret"]);
    expect(out.ok).toBe(false);
    expect(String(out.error).startsWith(MATERIALS_BLOCKED)).toBe(true);
    expect(listLendOrders(db(d), "T-secret").filter((o) => o.step === "fix")).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("## P1\n- race-1\n");
  }, 60_000);

  test("不同项目各按自己的模式：同一策略文件里 p on、q off", async () => {
    await d.policy({ [P]: "on", [Q]: "off" });
    await fixCard(d, "T-p", P, "## P1\n- race-1\n", FINDINGS);
    await fixCard(d, "T-q", Q, "## P1\n- race-1\n", FINDINGS);
    const a = await d.run(["ledger", "lend-offer", "T-p"]), b = await d.run(["ledger", "lend-offer", "T-q"]);
    expect([a.out.ok, b.out.ok]).toEqual([true, true]);
    expect((await claimFix(d, "T-p")).inputs.some((s) => s.startsWith(LABEL))).toBe(true);
    const q = await claimFix(d, "T-q");
    expect(q.inputs.some((s) => s.startsWith(FULL))).toBe(true);
    expect(q.text).not.toContain(LABEL);
    expect(d.calls()).toEqual(expect.arrayContaining([`${a.pid} ${P}:materials`, `${b.pid} ${Q}:materials`]));
  }, 60_000);

  test("build 单不读策略", async () => {
    const before = d.calls().length;
    await delivered(d, "T-build", P);
    expect(d.calls().length).toBe(before);
  }, 60_000);
});

describe("PM ledger lend-offer：bun build 产物（dist/manager.js）仍找到源码树 src/lib 下的正式 reader", () => {
  let d: Deployment;
  beforeAll(() => { d = deployment({ bundle: true }); });
  afterAll(() => { d.close(); closeLedger(ledgerFile(d)); });

  test("on：产物进程读到正式位置的 reader，线上发结构化材料；挪走 reader = observe 且诊断指向 src/lib", async () => {
    expect(d.manager).toBe(join(d.root, "dist", "manager.js"));
    expect(existsSync(join(d.root, "lib", "recovery-policy.ts"))).toBe(false);
    await d.policy({ [P]: "on" });
    await fixCard(d, "B1", P, `## P1\n- race-1：${SECRET}\n`, FINDINGS);
    const { out, pid } = await d.run(["ledger", "lend-offer", "B1"]);
    expect(out).toMatchObject({ ok: true, step: "fix" });
    expect(out.materialsDiag).toBeUndefined();
    expect(d.calls()).toContain(`${pid} ${P}:materials`);
    const got = await claimFix(d, "B1");
    expect(got.text).not.toContain("ghp_");
    expect(got.inputs.find((s) => s.startsWith(LABEL))).toContain(n("问题说明（审查方原文）：\n> 并发写丢数据"));
    await fixCard(d, "B2", P, "## P1\n- race-1\n", FINDINGS);
    d.hideReader();
    try {
      const miss = await d.run(["ledger", "lend-offer", "B2"]);
      expect(miss.out.materialsDiag).toContain(d.reader);
      expect((await claimFix(d, "B2")).inputs.some((s) => s.startsWith(FULL))).toBe(true);
    } finally { d.restoreReader(); }
  }, 120_000);

  test("产物部署：reader 从源码树正式位置挪走 = 未安装：observe，全文照发，命令结果带诊断；放回后下一个进程又读到", async () => {
    await d.policy({ [P]: "on" });
    await fixCard(d, "B-missing", P, "## P1\n- race-1\n", FINDINGS);
    d.hideReader();
    try {
      const before = d.calls().length;
      const { out } = await d.run(["ledger", "lend-offer", "B-missing"]);
      expect(out).toMatchObject({ ok: true, step: "fix" });
      expect(out.materialsDiag).toContain("未安装");
      expect(out.materialsDiag).toContain(d.reader);
      expect(d.calls().length).toBe(before);
      expect((await claimFix(d, "B-missing")).inputs.some((s) => s.startsWith(FULL))).toBe(true);
      expect(materialsOf(d, "B-missing")).toEqual([expect.objectContaining({ mode: "observe" })]);
    } finally { d.restoreReader(); }
    await fixCard(d, "B-back", P, "## P1\n- race-1\n", FINDINGS);
    const back = await d.run(["ledger", "lend-offer", "B-back"]);
    expect(back.out).toMatchObject({ ok: true, step: "fix" });
    expect(back.out.materialsDiag).toBeUndefined();
    expect(d.calls()).toContain(`${back.pid} ${P}:materials`);
    expect((await claimFix(d, "B-back")).inputs.some((s) => s.startsWith(LABEL))).toBe(true);
  }, 120_000);
});


/**
 * 调度服务自动挂池：卡走到 fix 之前的 tick 在进程内（tests/scheduler-auto-helpers.ts 的真台账文件 + 真 tick），挂修复单那一轮的
 * manager 调用改成部署里的真 manager 进程，带调度服务身份（CLAUDESTRA_SCHEDULER_SERVICE=1）和测试持有的真租约锁，
 * 与 lib/scheduler-service.ts schedulerManagerWith 同一组 env；子进程走 realDeps / realLendDeps（不注入 lend、不注入 reader）。
 */
describe("调度服务 scheduler-pool：调度服务身份的 manager 进程挂修复单，对方经假网络收单", () => {
  const WRITE: RemotePolicy = { mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, repo: "o/r" };
  const DESCRIBED = { ...P1, description: "两个 tick 同时认领同一意图，第二个应被 CAS 拒" };

  async function ready(modes: Record<string, string>, opts: { bundle?: boolean } = {}) {
    const f = autoFixture({ reviewerRuntime: "claude-code" });
    f.advance(Date.now() - 600_000); // 台账时钟拨到真实时间之前一点：子进程按 Date.now() 写
    const d = deployment({ state: f.dir, bundle: opts.bundle });
    await d.policy(modes);
    const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
    delete reg.agents["agent-rv-t1"].transport;
    writeFileSync(f.registryPath, JSON.stringify(reg));
    writeFileSync(join(d.state, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "p", dirs: [join(d.root, "proj-p")], createdAt: "" }] }));
    const spec = join(f.dir, "T1.md");
    writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
    f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [spec]);
    const reports = join(f.dir, "reports");
    mkdirSync(reports);
    const key = instanceKeySync(mkdtempSync(join(f.dir, "key-")))!;
    const borrow = [{ peer: "mate", projects: ["p"], roles: ["review", "write"] as ("review" | "write")[], maxOpen: 3 }];
    const policy = { maxActiveWorkers: 2, remote: WRITE };
    const remote: Record<string, RemoteHead> = { main: { ok: true, head: H1 } };
    d.setRemote("main", H1);
    const lend = { borrow: async () => borrow, notifyPm: async () => {}, schedulerPolicy: () => policy,
      result: { reportDir: () => reports, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, key),
        peerFp: async () => d.mateFp, remoteHead: async (_r: string, b: string) => remote[b] ?? { ok: false as const, error: "没有这个分支" } } };
    const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Record<string, any>>;
    const inProc = async (...args: string[]) => cli("scheduler", ...args.slice(1));
    const singleton = (await acquireLock(join(f.dir, "scheduler.lock")))!, maintenance = (await acquireLock(join(f.dir, "maintenance.lock")))!;
    const lease = encodeLease({ singleton: { path: join(f.dir, "scheduler.lock"), token: singleton.token }, maintenance: { path: join(f.dir, "maintenance.lock"), token: maintenance.token } });
    const pids: number[] = [];
    const service = async (...args: string[]) => {
      const r = await d.run(args, { CLAUDESTRA_SCHEDULER_SERVICE: "1", DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_LEASE: lease });
      pids.push(r.pid);
      return r.out;
    };
    let manager: (...args: string[]) => Promise<Record<string, unknown>> = inProc;
    const tick = async () => {
      const r = await schedulerAutoTick(f.db, { p: policy }, { ...f.tickDeps, manager: (...a) => manager(...a), borrow: async () => borrow });
      if (r.failed.length) throw new Error(JSON.stringify(r.failed));
      return r.cards[0];
    };
    let seq = 0;
    const hello = () => recordHello(f.db, "mate", null, { v: 1, proto: 2, boot: "boot-mate", seq: ++seq, slots: { codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } },
      paused: null, grant: { until: f.tickDeps.now() + 3_600_000, roles: ["review", "write"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50 } }, f.tickDeps.now());
    await toBuild(f);
    const close = () => { singleton.release(); maintenance.release(); d.close(); f.close(); };
    return { f, d, cli, tick, hello, remote, pids, close, useService: () => { manager = service; }, orders: () => listLendOrders(f.db, "T1") };
  }
  type Ready = Awaited<ReturnType<typeof ready>>;

  /** Build → mate writes over the in-process lend CLI → local reviewer records one P1 with `findings` → fix. */
  async function toFix(p: Ready, report: string, findings: unknown[]): Promise<string> {
    p.hello();
    await p.tick();
    const [order] = p.orders();
    const BRANCH = order.branch!;
    await p.cli("owner", "lend-claim", "--", "mate", JSON.stringify({ v: 1, orderId: order.orderId, worker: "w1" }));
    p.remote[BRANCH] = { ok: true, head: AUTO_H2 };
    p.d.setRemote(BRANCH, AUTO_H2);
    await p.cli("owner", "lend-write", "--", "mate", JSON.stringify({ v: 1, orderId: order.orderId, gen: 1, branch: BRANCH, pr: 7, session: { id: "sess-1", family: "codex" },
      deliver: { v: 1, orderId: order.orderId, head: AUTO_H2, evidence: BRANCH, summary: "实现了 x", selfCheck: "单测全绿" } }));
    for (let i = 0; i < 3; i++) await p.tick();
    const path = join(p.f.dir, "report.md"), rows = join(p.f.dir, "p1.json");
    writeFileSync(path, report);
    writeFileSync(rows, JSON.stringify(findings));
    expect(await p.cli("agent-rv-t1", "review", "T1", "--reviewer", "agent-rv-t1", "--verdict", "changes", "--p0", "0", "--p1", "1", "--p2", "0",
      "--head", AUTO_H2, "--session", "s-rv", "--family", "claude", "--findings", rows, "--path", path)).toMatchObject({ ok: true });
    await p.tick();
    expect(p.f.task().stage).toBe("fix");
    return path;
  }

  /** The pooling tick runs its manager calls as service processes; mate then claims the fix order over the network. */
  async function pooledFix(p: Ready) {
    p.f.advance(Date.now() - p.f.tickDeps.now()); // 服务进程按真实时间看 hello 新不新
    p.hello();
    p.useService();
    expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
    const fix = p.orders().at(-1)!;
    expect(fix).toMatchObject({ step: "fix", peer: "mate" });
    const r = await p.d.peer("claim", { v: 1, orderId: fix.orderId, worker: "fixer" });
    expect(r.status).toBe(200);
    return { text: r.text, inputs: r.json.order.inputs as string[], findings: r.json.order.findings as { probe: string }[] };
  }
  const notes = (p: Ready) => listEvents(p.f.db, { target: "T1" }).filter((e) => e.kind === "note" && (e.data.lend as any)?.op === "offer" &&
    (e.data.lend as any).step === "fix").map((e) => (e.data.lend as any).materials);

  test("on：服务进程读正式位置 reader，线上只有结构化项、原 description 逐字；报告全文（含密钥样内容）不发、本机不变", async () => {
    const p = await ready({ p: "on" });
    try {
      const report = `# 审查报告\nP1：复现用了 ${SECRET}`;
      const path = await toFix(p, report, [DESCRIBED]);
      expect(p.d.calls()).toEqual([]);
      const got = await pooledFix(p);
      expect(p.d.calls().filter((c) => c.endsWith(" p:materials")).map((c) => Number(c.split(" ")[0])).every((pid) => p.pids.includes(pid))).toBe(true);
      expect(p.d.calls().length).toBeGreaterThan(0);
      expect(got.text).not.toContain("ghp_");
      expect(got.inputs.some((s) => s.startsWith(FULL))).toBe(false);
      expect(got.inputs.find((s) => s.startsWith(LABEL))).toContain(n(`问题说明（审查方原文）：\n> ${DESCRIBED.description}`));
      expect(got.findings.map((f) => f.probe)).toEqual([P1.probe]);
      expect(notes(p)).toEqual([expect.objectContaining({ mode: "on", items: 1, undescribed: 0 })]);
      expect(readFileSync(path, "utf8")).toBe(report);
    } finally { p.close(); }
  }, 120_000);

  test("observe：全文照发，只记 would-send", async () => {
    const p = await ready({ p: "observe" });
    try {
      await toFix(p, "# 审查报告\nP1：两个 tick 抢同一个意图", [DESCRIBED]);
      const got = await pooledFix(p);
      expect(got.inputs.some((s) => s.startsWith(FULL) && s.includes(n("P1：两个 tick 抢同一个意图")))).toBe(true);
      expect(got.text).not.toContain(LABEL);
      expect(notes(p)).toEqual([expect.objectContaining({ mode: "observe", items: 1 })]);
    } finally { p.close(); }
  }, 120_000);

  test("reader 不在正式位置 = observe：全文照发（与改动前同一条路），reader 没被调用（产物部署制造未安装）", async () => {
    const p = await ready({ p: "on" }, { bundle: true });
    try {
      await toFix(p, "# 审查报告\nP1：两个 tick 抢同一个意图", [DESCRIBED]);
      p.d.hideReader();
      const got = await pooledFix(p);
      expect(got.inputs.some((s) => s.startsWith(FULL))).toBe(true);
      expect(notes(p)).toEqual([expect.objectContaining({ mode: "observe" })]);
      expect(p.d.calls()).toEqual([]);
    } finally { p.close(); }
  }, 120_000);

  test("敏感的必需 description：on 被外发闸拒，不出修复单，不改发全文", async () => {
    const p = await ready({ p: "on" });
    try {
      await toFix(p, "# 审查报告\nP1", [{ ...P1, description: `复现：curl -H 'Authorization: Bearer ${SECRET}'` }]);
      p.f.advance(Date.now() - p.f.tickDeps.now());
      p.hello();
      p.useService();
      expect(await p.tick()).toMatchObject({ step: "pool_refused", detail: expect.stringContaining(MATERIALS_BLOCKED) });
      expect(p.orders().filter((o) => o.step === "fix")).toEqual([]);
      expect(p.d.calls().map((c) => Number(c.split(" ")[0])).every((pid) => p.pids.includes(pid))).toBe(true);
      expect(p.d.calls().length).toBeGreaterThan(0);
    } finally { p.close(); }
  }, 120_000);
});
