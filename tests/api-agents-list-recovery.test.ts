/**
 * AGL1：GET /api/v1/agents?include=stopped 在 400 条 registry（380 个已停出借 worker）下 1 秒内返回，
 * 已停 worker 零尾读，普通 / 活会话全局有界并发 + 短缓存，读失败降级 unknown 并记日志。
 *
 * 真实隔离接口：子进程带临时 HOME / 状态目录 / 运行目录 / TMPDIR、最小 env（testChildEnv，不继承、不读 .env）、
 * bridge 指向死端口；经 serveApiRequest 真鉴权（principals.json 由 lib 写）、真 registry.json、真 scope 筛选。
 * 注入的只有 IO：会话尾读（每次 10ms 合成延迟，记路径 / 并发峰值；两条会话走真实读取验证失败日志）、
 * Codex rollout 全库查找（计数、只对已停普通 Codex 返回合成路径）、tmux（计数、抛错）、manager list（不起子进程）、
 * 更新提示（不探真实 claude 版本）。
 * 用例对老实现同样可跑：老实现在这里串行读 700+ 次尾、找 80 次 rollout（旧红），新实现只读 20 次、有界并行（新绿）。
 */
import { expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../src/lib/repo-root.ts";
import { testChildEnv } from "./test-env.ts";

const CHILD_FLAG = "CLAUDESTRA_TEST_AGL1_CHILD";
/** 与 src/bridge/agents-list-tails.ts 的 TAIL_CONCURRENCY（全局读槽）/ TAIL_CACHE_TTL_MS 同值（这里不 import 新模块，老实现也要能跑出红） */
const MAX_PARALLEL = 8;
const CACHE_TTL_MS = 3_000;
const TAIL_LATENCY_MS = 10;
const BUDGET_MS = 1_000;

if (process.env[CHILD_FLAG] !== "1") {
  test("api-agents-list-recovery（临时 HOME / 状态目录 / 运行目录的子进程，最小 env，不读 .env，死 bridge）", async () => {
    const root = mkdtempSync(join(tmpdir(), "agl1-list-"));
    const home = join(root, "home");
    const tmp = join(root, "tmp");
    mkdirSync(home);
    mkdirSync(tmp);
    writeFileSync(join(root, "empty.env"), "");
    try {
      const child = Bun.spawn([process.execPath, `--env-file=${join(root, "empty.env")}`, "test", import.meta.path], {
        cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe",
        env: testChildEnv({
          HOME: home, TMPDIR: tmp, LANG: "C",
          CLAUDESTRA_STATE_DIR: join(home, ".claude-orchestrator"), CLAUDESTRA_RUNTIME_DIR: join(tmp, "runtime"),
          [CHILD_FLAG]: "1",
        }),
      });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      for (const line of (out + err).split("\n")) if (line.startsWith("[AGL1]")) process.stderr.write(line + "\n"); // 证据行：耗时 / 读数
      if (code !== 0) throw new Error(`子进程 bun test 退出码 ${code}\n${(out + err).slice(-8000)}`);
      expect(err).toMatch(/\b0 fail\b/);
      expect(err).toMatch(/\b[1-9]\d* pass\b/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
} else {
  await childSuite();
}

interface Reg { name: string; kind?: "worker" | "main"; status: string; cwd: string; sessionId: string; runtime?: string; purpose: string; channelId: string; projectId: string; created: string }

async function childSuite(): Promise<void> {
  const { describe, test: it, beforeAll } = await import("bun:test");
  const home = process.env.HOME!;
  const cwdOf = (i: number) => join(home, "repos", `proj-${i % 5}`);
  const sid = (tag: string) => `00000000-${tag.padStart(4, "0")}-4000-8000-000000000000`.slice(0, 36);
  const reg = (name: string, status: string, i: number, extra: Partial<Reg> = {}): Reg => ({
    name, status, cwd: cwdOf(i), sessionId: sid(String(i)), purpose: `p ${name}`, channelId: `ch-${i}`, projectId: "p1", created: "2026-10-01T00:00:00Z", ...extra,
  });
  // 400 条：380 显式标记的已停 worker（299 Claude 有会话文件 + 80 Codex 无文件 + 1 无命名特征）、20 普通/活会话
  // （10 活、1 活 worker、7 已停 Claude、1 已停普通 Codex、1 名字像 worker 但 kind=main 的普通会话）
  const regs: Reg[] = [];
  for (let i = 0; i < 299; i++) regs.push(reg(`agent-lend-${i.toString(16).padStart(10, "0")}`, "stopped", 1000 + i, { kind: "worker" }));
  for (let i = 0; i < 80; i++) regs.push(reg(`agent-lend-cx${i.toString(16).padStart(8, "0")}`, "stopped", 2000 + i, { kind: "worker", runtime: "codex" }));
  regs.push(reg("agent-arbitrary-worker", "stopped", 2999, { kind: "worker" }));
  const ACTIVE = Array.from({ length: 10 }, (_, i) => `agent-a${String(i + 1).padStart(2, "0")}`);
  const STOPPED_NORMAL = [...Array.from({ length: 5 }, (_, i) => `agent-s${String(i + 1).padStart(2, "0")}`), "agent-task-manual", "agent-lend-manual"];
  const STOPPED_CODEX = "agent-codex-stopped"; // 已停的普通 Codex：rollout 路径推不出来，只能按 id 找（已停 worker 不找）
  const DIR_TAIL = "agent-s02"; // 会话路径上是个目录：真实读失败 → unknown + 一条日志
  const MISSING_TAIL = "agent-s03"; // 会话文件不存在：unknown，不记日志（已归档 / 清理过的会话是常态）
  const ACTIVE_WORKER = "agent-lend-active-worker";
  const SAME_NAME_MAIN = "agent-lend-samename-main";
  ACTIVE.forEach((n, i) => regs.push(reg(n, "active", 100 + i)));
  regs.push(reg(ACTIVE_WORKER, "active", 199, { kind: "worker" }));
  STOPPED_NORMAL.forEach((n, i) => regs.push(reg(n, "stopped", 300 + i)));
  regs.push(reg(STOPPED_CODEX, "stopped", 390, { kind: "main", runtime: "codex" }));
  regs.push(reg(SAME_NAME_MAIN, "stopped", 399, { kind: "main" }));
  expect(regs.length).toBe(400);
  const byName = new Map(regs.map((r) => [r.name, r]));
  const stoppedWorkers = regs.filter((r) => r.status === "stopped" && r.kind === "worker");
  expect(stoppedWorkers.length).toBe(380);

  const { REGISTRY_PATH } = await import("../src/lib/registry.ts");
  const { projectsSlug } = await import("../src/lib/jsonl-cost.ts");
  const sessionFile = (r: Reg) => join(home, ".claude", "projects", projectsSlug(r.cwd), `${r.sessionId}.jsonl`);
  const writeRegistry = () => writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: Object.fromEntries(regs.map((r) => [r.name, r])) }));
  mkdirSync(join(home, ".claude-orchestrator"), { recursive: true });
  writeRegistry();
  for (const r of regs) {
    if (r.runtime === "codex" || r.name === MISSING_TAIL) continue; // Codex 的 rollout 文件路径推不出来：老实现会按 id 全库找
    mkdirSync(join(sessionFile(r), ".."), { recursive: true });
    if (r.name === DIR_TAIL) mkdirSync(sessionFile(r));
    else writeFileSync(sessionFile(r), `{"type":"user","timestamp":"2026-10-01T00:00:00Z","message":{"role":"user","content":"hi ${r.name}"}}\n`);
  }
  const codexRollout = join(home, ".codex", "sessions", `rollout-${byName.get(STOPPED_CODEX)!.sessionId}.jsonl`);

  // ── 注入 IO（都在 import api-routes 之前）──
  const BAD_TAIL = "agent-a09"; // 读坏：抛错
  const NULL_TAIL = "agent-a10"; // 文件可读但没解析出任何字段（真实 sessionTailInfo 对可读文件返回全 null 的对象，不是 null）
  const reads: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let findCalls = 0;
  const paneProbes: string[] = [];
  const warns: string[] = [];
  const realTail = await import("../src/lib/session-tail.ts");
  const realSessionTailInfo = realTail.sessionTailInfo; // mock.module 会替换命名空间上的活绑定：mock 里经 realTail.x 调会调到自己
  const realReadFor = (path: string) => [DIR_TAIL, MISSING_TAIL].some((n) => path.includes(byName.get(n)!.sessionId));
  mock.module(join(import.meta.dir, "../src/lib/session-tail.ts"), () => ({
    ...realTail,
    sessionTailInfo: async (path: string) => {
      reads.push(path);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Bun.sleep(TAIL_LATENCY_MS);
      inFlight--;
      if (realReadFor(path)) return realSessionTailInfo(path); // 走真实读取：验证生产 IO 的失败日志，不是合成抛错
      if (path.includes(byName.get(BAD_TAIL)!.sessionId)) throw new Error("synthetic corrupt tail");
      if (path.includes(byName.get(NULL_TAIL)!.sessionId)) return { convTs: null, ctxTokens: null, ctxWindow: null, model: null, modelTs: null, effort: null, effortTs: null };
      const n = Number(/-(\d{4})-4000/.exec(path)?.[1] ?? 0);
      return { convTs: 1_760_000_000_000 + n, ctxTokens: 1234, ctxWindow: null, model: "claude-synthetic-model", modelTs: Date.now() - 1_000, effort: null, effortTs: null };
    },
  }));
  const realSource = await import("../src/lib/session-source.ts");
  mock.module(join(import.meta.dir, "../src/lib/session-source.ts"), () => ({
    ...realSource,
    findSessionJsonlBySessionId: (_runtime: string | undefined, sessionId: string) => (findCalls++, sessionId === byName.get(STOPPED_CODEX)!.sessionId ? codexRollout : null),
  }));
  const realTmux = await import("../src/lib/tmux-helper.ts");
  mock.module(join(import.meta.dir, "../src/lib/tmux-helper.ts"), () => ({
    ...realTmux,
    tmuxRaw: async (args: string[]) => {
      paneProbes.push(args.join(" "));
      throw new Error("no tmux server in test");
    },
  }));
  const realHints = await import("../src/lib/update-hints.ts");
  mock.module(join(import.meta.dir, "../src/lib/update-hints.ts"), () => ({ ...realHints, attachUpdateHints: async () => {} }));
  const realMgmt = await import("../src/bridge/management.ts");
  const activeRows = [...ACTIVE, ACTIVE_WORKER].map((name) => {
    const r = byName.get(name)!;
    return {
      name, status: "active", idle: name !== "agent-a02", cwd: r.cwd, purpose: r.purpose, channelId: r.channelId, sessionId: r.sessionId,
      runtime: "claude-code", projectId: "p1", created: r.created,
    };
  });
  mock.module(join(import.meta.dir, "../src/bridge/management.ts"), () => ({
    ...realMgmt,
    runManager: async (...args: string[]) => (args[0] === "list" ? { ok: true, agents: activeRows } : { ok: false, error: `manager ${args[0]} 不在本测试里` }),
  }));

  const { initApiRoutes, serveApiRequest } = await import("../src/bridge/api-routes.ts");
  const { setRequestContext } = await import("../src/bridge/request-context.ts");
  const { newTokenPrincipal, updatePrincipals } = await import("../src/lib/principals.ts");
  const { emitEvent } = await import("../src/bridge/event-bus.ts");
  const { USER_ARCHIVE_ROOT } = await import("../src/lib/session-archive.ts");

  const SCOPED_WORKER = stoppedWorkers[0]!.name;
  const full = newTokenPrincipal("full", ["*"]);
  const scoped = newTokenPrincipal("scoped", ["agent-a01", "agent-s01", ACTIVE_WORKER, SCOPED_WORKER]);
  type Row = Record<string, unknown> & { name: string };
  const get = async (secret: string | null, query = "?include=stopped") => {
    const req = new Request(`http://127.0.0.1:9/api/v1/agents${query}`, { headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
    setRequestContext(req, { source: "loopback", clientIp: null, https: false });
    const t0 = performance.now();
    const res = await serveApiRequest(req, new URL(req.url));
    const ms = performance.now() - t0;
    const body = (await res.json()) as { ok: boolean; agents?: Row[]; error?: string };
    return { res, ms, body, rows: new Map((body.agents ?? []).map((a) => [a.name, a])) };
  };
  const workerReads = () => reads.filter((p) => stoppedWorkers.some((w) => p.includes(w.sessionId))).length;
  const warnsFor = (name: string) => warns.filter((w) => w.includes(name));

  beforeAll(async () => {
    console.warn = (...args: unknown[]) => void warns.push(args.map(String).join(" ")); // 读失败日志走 console.warn（子进程，不必还原）
    await updatePrincipals((f) => (f.principals.push(full, scoped), { changed: true, result: null }));
    mkdirSync(join(USER_ARCHIVE_ROOT, stoppedWorkers[1]!.name.replace(/^agent-/, "")), { recursive: true });
    mkdirSync(join(USER_ARCHIVE_ROOT, "a05"), { recursive: true });
    emitEvent({ agent: "agent-a01", chatId: "ch-100", type: "agent_status", data: { status: "thinking" } });
    emitEvent({ agent: "agent-a04", chatId: "ch-103", type: "agent_status", data: { status: "compacting" } });
    initApiRoutes({
      clients: new Map(), deliver: async (env: unknown) => ({ envelope: env, outcome: { kind: "sent" } }), mirrorApiExchange: async () => {},
      startTypingWithSafety: () => {}, lastMessageSource: new Map(), handleEventsRequest: () => new Response("events"), scheduleClearRotation: () => {},
    } as never);
  });

  describe("GET /agents?include=stopped：400 条 registry、380 个已停出借 worker", () => {
    it("认证请求 1 秒内返回；已停 worker 零尾读 / 零 rollout 查找 / 零 pane 探测；20 个普通会话有界并行", async () => {
      const r = await get(full.secret!);
      process.stderr.write(`[AGL1] include=stopped 400 条：${r.ms.toFixed(0)}ms，尾读 ${reads.length} 次（其中已停 worker ${workerReads()}），` +
        `rollout 查找 ${findCalls} 次，并发峰值 ${maxInFlight}，pane 探测 ${paneProbes.length}\n`);
      if (r.res.status !== 200) process.stderr.write(`[AGL1] 接口报错：${r.res.status} ${r.body.error}\n`);
      expect(r.res.status).toBe(200);
      expect(r.body.agents!.length).toBe(400);
      expect(r.ms).toBeLessThan(BUDGET_MS);
      expect(workerReads()).toBe(0);
      expect(findCalls).toBe(1); // 只有已停的普通 Codex 按 id 找 rollout；80 个已停 Codex worker 一次都不找
      expect(paneProbes.filter((p) => stoppedWorkers.some((w) => p.includes(w.name)))).toEqual([]);
      expect(reads.length).toBe(20); // 10 活 + 1 活 worker + 7 已停普通 + 1 已停普通 Codex + 1 kind=main
      expect(new Set(reads).size).toBe(20);
      expect(reads).toContain(codexRollout);
      expect(maxInFlight).toBeGreaterThan(1); // 不串行
      expect(maxInFlight).toBeLessThanOrEqual(MAX_PARALLEL); // 有界
    }, 60_000);

    it("字段语义不变：已停 worker 最小元数据 + 归档；普通 / 活会话的 lastActivityTs / contextTokens / model / busy / compacting / 坏尾降级", async () => {
      const { rows } = await get(full.secret!);
      const w = rows.get(stoppedWorkers[0]!.name)!;
      expect(w).toMatchObject({ status: "stopped", kind: "worker", lastActivityTs: null, purpose: `p ${w.name}`, projectId: "p1", runtime: "claude-code", archived: false });
      expect(rows.get(stoppedWorkers[1]!.name)!.archived).toBe(true);
      expect(rows.get("agent-lend-cx00000000")!.runtime).toBe("codex");
      expect(rows.get("agent-arbitrary-worker")).toMatchObject({ kind: "worker", lastActivityTs: null });
      expect(rows.get("agent-task-manual")).toMatchObject({ kind: null, lastActivityTs: 1_760_000_000_000 + 305 });
      expect(rows.get("agent-lend-manual")).toMatchObject({ kind: null, lastActivityTs: 1_760_000_000_000 + 306 });
      expect(rows.get(SAME_NAME_MAIN)!.lastActivityTs).toBe(1_760_000_000_000 + 399); // 名字像 worker 但 kind=main：照常读尾
      expect(rows.get("agent-s01")!.lastActivityTs).toBe(1_760_000_000_000 + 300);
      expect(rows.get(STOPPED_CODEX)).toMatchObject({ status: "stopped", runtime: "codex", lastActivityTs: 1_760_000_000_000 + 390 }); // 已停普通 Codex 不误跳
      expect(rows.get(ACTIVE_WORKER)).toMatchObject({ status: "active", kind: "worker", lastActivityTs: 1_760_000_000_000 + 199, contextTokens: 1234 });
      expect(rows.get("agent-a01")).toMatchObject({
        status: "active", busy: true, compacting: false, contextTokens: 1234, lastActivityTs: 1_760_000_000_000 + 100,
        model: "claude-synthetic-model", archived: false, projectId: "p1",
      });
      expect(rows.get("agent-a02")!.busy).toBe(true); // manager idle=false 兜底
      expect(rows.get("agent-a03")!.busy).toBe(false);
      expect(rows.get("agent-a04")).toMatchObject({ busy: true, compacting: true });
      expect(rows.get("agent-a05")!.archived).toBe(true);
      expect(rows.get(BAD_TAIL)).toMatchObject({ lastActivityTs: null, contextTokens: null, status: "active" }); // 坏尾：unknown，不是 0
      expect(rows.get(NULL_TAIL)).toMatchObject({ lastActivityTs: null, contextTokens: null });
      expect(rows.get("agent-a01")!.cwd).toBe(cwdOf(100));
    }, 60_000);

    it("读失败记日志、降级 unknown：真实 IO 失败（路径是目录）记一条；文件不存在不记；合成抛错也记", async () => {
      const { rows } = await get(full.secret!);
      expect(rows.get(DIR_TAIL)).toMatchObject({ status: "stopped", lastActivityTs: null });
      expect(rows.get(MISSING_TAIL)).toMatchObject({ status: "stopped", lastActivityTs: null });
      expect(warnsFor(DIR_TAIL).length).toBe(1);
      expect(warnsFor(DIR_TAIL)[0]).toMatch(/不是普通文件/);
      expect(warnsFor(MISSING_TAIL)).toEqual([]);
      expect(warnsFor(NULL_TAIL)).toEqual([]); // 可读但空：不是读失败
      expect(warnsFor(BAD_TAIL).length).toBe(1);
      expect(warnsFor(BAD_TAIL)[0]).toContain("synthetic corrupt tail");
    }, 60_000);

    it("短缓存：同一会话内再请求不重读；registry 换 sessionId 立即失效只重读那一条；TTL 过后整批重读", async () => {
      const before = reads.length;
      const r2 = await get(full.secret!);
      expect(r2.res.status).toBe(200);
      expect(reads.length).toBe(before); // 全部命中缓存
      process.stderr.write(`[AGL1] 缓存命中的第二次请求：${r2.ms.toFixed(0)}ms，尾读 0 次\n`);
      const a01 = byName.get("agent-a01")!;
      a01.sessionId = sid("9100");
      mkdirSync(join(sessionFile(a01), ".."), { recursive: true });
      writeFileSync(sessionFile(a01), "{}\n");
      writeRegistry();
      const r3 = await get(full.secret!);
      expect(reads.length).toBe(before + 1);
      expect(reads.at(-1)).toContain(sid("9100"));
      expect(r3.rows.get("agent-a01")!.lastActivityTs).toBe(1_760_000_000_000 + 9100);
      await Bun.sleep(CACHE_TTL_MS + 100);
      await get(full.secret!);
      expect(reads.length).toBe(before + 1 + 20);
    }, 60_000);

    it("冷缓存并发请求共用全局读槽：5 个同时到的认证请求只读 20 次、峰值仍 ≤ 8；读失败日志也只记一次", async () => {
      await Bun.sleep(CACHE_TTL_MS + 100);
      const before = reads.length;
      const warnsBefore = warns.length;
      maxInFlight = 0;
      const rs = await Promise.all(Array.from({ length: 5 }, () => get(full.secret!)));
      process.stderr.write(`[AGL1] 冷缓存 5 并发：尾读 ${reads.length - before} 次，并发峰值 ${maxInFlight}\n`);
      for (const r of rs) expect(r.body.agents!.length).toBe(400);
      expect(reads.length - before).toBe(20);
      expect(maxInFlight).toBeLessThanOrEqual(MAX_PARALLEL);
      expect(maxInFlight).toBeGreaterThan(1);
      expect(warns.length - warnsBefore).toBe(2); // DIR_TAIL + BAD_TAIL 各一条，不是每个请求各记一遍
      for (const r of rs) expect(r.rows.get("agent-a01")!.lastActivityTs).toBe(1_760_000_000_000 + 9100);
    }, 60_000);

    it("并发多 scope 不串：受限 token 只看到自己的 4 个，且已停 worker 仍不读尾", async () => {
      const before = workerReads();
      const [f, s] = await Promise.all([get(full.secret!), get(scoped.secret!)]);
      expect(f.body.agents!.length).toBe(400);
      expect([...s.rows.keys()].sort()).toEqual(["agent-a01", "agent-s01", ACTIVE_WORKER, SCOPED_WORKER].sort());
      expect(s.rows.get(SCOPED_WORKER)).toMatchObject({ status: "stopped", lastActivityTs: null });
      expect(workerReads()).toBe(before);
    }, 60_000);

    it("撤销 / 收窄立即生效：缓存只存会话尾，不存授权结果", async () => {
      await updatePrincipals((f) => ((f.principals = f.principals.filter((p) => p.id !== scoped.id)), { changed: true, result: null }));
      expect((await get(scoped.secret!)).res.status).toBe(401);
      await get(full.secret!); // 先把缓存焐热，收窄后的那次请求不该再读
      const before = reads.length;
      await updatePrincipals((f) => ((f.principals.find((p) => p.id === full.id)!.agents = ["agent-a01"]), { changed: true, result: null }));
      const narrowed = await get(full.secret!);
      expect([...narrowed.rows.keys()]).toEqual(["agent-a01"]);
      expect(reads.length).toBe(before); // 缓存仍热，但 scope 外的一条都不出现
      await updatePrincipals((f) => ((f.principals.find((p) => p.id === full.id)!.agents = ["*"]), { changed: true, result: null }));
    }, 60_000);

    it("不带 include：只有 manager list 里的会话，已停的一条不出现、一次尾读都不多", async () => {
      await Bun.sleep(CACHE_TTL_MS + 100);
      const before = reads.length;
      const r = await get(full.secret!, "");
      expect([...r.rows.keys()].sort()).toEqual([...ACTIVE, ACTIVE_WORKER].sort());
      expect(reads.length - before).toBe(11);
      expect(workerReads()).toBe(0);
    }, 60_000);

    it("既有授权负例不退：无凭据 / 假 token → 401，不读任何会话尾", async () => {
      const before = reads.length;
      expect((await get(null)).res.status).toBe(401);
      expect((await get("bogus-secret")).res.status).toBe(401);
      expect(reads.length).toBe(before);
    });
  });
}
