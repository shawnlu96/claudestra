/**
 * SYN-4：/api/v1/agents/:name/* 按名字找 agent 不再每次现起 `manager list`。
 * 子进程（临时 HOME / 状态目录、最小 env、死 bridge）里经 serveApiRequest 真鉴权、真 registry.json；
 * 只注入 manager（计数的 runManager，不起子进程）和 tmux（抛错）。
 * 老实现：10 个 /pending 调 10 次 list（红）；新实现：缓存期内 1 次（绿）。找人语义逐条对照老实现。
 */
import { expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../src/lib/repo-root.ts";
import { testChildEnv } from "./test-env.ts";

const CHILD_FLAG = "CLAUDESTRA_TEST_SYN4_CHILD";
const CONTROL = "ctl-syn4";

if (process.env[CHILD_FLAG] !== "1") {
  test("api-routes agent lookup（临时 HOME 子进程，最小 env，死 bridge）", async () => {
    const root = mkdtempSync(join(tmpdir(), "syn4-lookup-"));
    const home = join(root, "home");
    const tmp = join(root, "tmp");
    mkdirSync(home);
    mkdirSync(tmp);
    writeFileSync(join(root, "empty.env"), "");
    try {
      const child = Bun.spawn([process.execPath, `--env-file=${join(root, "empty.env")}`, "test", import.meta.path], {
        cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe",
        env: testChildEnv({
          HOME: home, TMPDIR: tmp, LANG: "C", MASTER_DIR: join(home, "master"),
          CLAUDESTRA_STATE_DIR: join(home, ".claude-orchestrator"), CLAUDESTRA_RUNTIME_DIR: join(tmp, "runtime"),
          [CHILD_FLAG]: "1",
        }),
      });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      for (const line of (out + err).split("\n")) if (line.startsWith("[SYN4]")) process.stderr.write(line + "\n");
      if (code !== 0) throw new Error(`子进程 bun test 退出码 ${code}\n${(out + err).slice(-8000)}`);
      expect(err).toMatch(/\b0 fail\b/);
      expect(err).toMatch(/\b[1-9]\d* pass\b/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
} else {
  await childSuite();
}

async function childSuite(): Promise<void> {
  const { describe, test: it, beforeAll, beforeEach } = await import("bun:test");
  const home = process.env.HOME!;
  process.env.CONTROL_CHANNEL_ID = CONTROL; // tests/preload.ts 会删掉它；api-routes 在模块加载时读，必须赶在下面 import 之前
  const row = (name: string, status = "active") => ({ name, status, idle: true, channelId: `ch-${name}`, cwd: join(home, "w"), sessionId: "", runtime: "claude-code", purpose: "" });
  // registry 里：worker 活、gone 已停（manager list 不列已停的）；list 里 dead 是窗口没了的 active 条目
  const registry: Record<string, { name: string; status: string; channelId: string; cwd: string }> = {
    "agent-worker": { name: "agent-worker", status: "active", channelId: "ch-agent-worker", cwd: join(home, "w") },
    "agent-gone": { name: "agent-gone", status: "stopped", channelId: "ch-agent-gone", cwd: join(home, "w") },
    "agent-dead": { name: "agent-dead", status: "active", channelId: "ch-agent-dead", cwd: join(home, "w") },
  };
  let listed = [row("agent-worker"), row("agent-dead", "dead")];
  let failList = false;
  let listCalls = 0;

  const { REGISTRY_PATH } = await import("../src/lib/registry.ts");
  mkdirSync(join(home, ".claude-orchestrator"), { recursive: true });
  const writeRegistry = () => writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: registry }));
  writeRegistry();

  const realTmux = await import("../src/lib/tmux-helper.ts");
  mock.module(join(import.meta.dir, "../src/lib/tmux-helper.ts"), () => ({
    ...realTmux,
    tmuxRaw: async () => {
      throw new Error("no tmux server in test");
    },
  }));
  const realMgmt = await import("../src/bridge/management.ts");
  mock.module(join(import.meta.dir, "../src/bridge/management.ts"), () => ({
    ...realMgmt,
    runManager: async (...args: string[]) => {
      if (args[0] !== "list") return { ok: false, error: `manager ${args[0]} 不在本测试里` };
      listCalls++;
      await Bun.sleep(20); // 子进程有耗时：并发请求要能合到同一次
      return failList ? { ok: false, error: "manager list 超时" } : { ok: true, agents: listed };
    },
  }));

  const { initApiRoutes, serveApiRequest } = await import("../src/bridge/api-routes.ts");
  const { setRequestContext } = await import("../src/bridge/request-context.ts");
  const { newTokenPrincipal, updatePrincipals } = await import("../src/lib/principals.ts");
  const full = newTokenPrincipal("full", ["*", "master"]);

  const pending = async (name: string) => {
    const req = new Request(`http://127.0.0.1:9/api/v1/agents/${encodeURIComponent(name)}/pending`, { headers: { Authorization: `Bearer ${full.secret}` } });
    setRequestContext(req, { source: "loopback", clientIp: null, https: false });
    const res = await serveApiRequest(req, new URL(req.url));
    return { status: res.status, body: (await res.json()) as { ok: boolean; agent?: string; error?: string } };
  };
  /** 让缓存一定作废：重写 registry（create / kill / rename 都会写它） */
  const touchRegistry = async () => {
    await Bun.sleep(5); // mtime 精度：保证和上一版不同
    writeRegistry();
  };

  beforeAll(async () => {
    await updatePrincipals((f) => (f.principals.push(full), { changed: true, result: null }));
    initApiRoutes({
      clients: new Map(), deliver: async (env: unknown) => ({ envelope: env, outcome: { kind: "sent" } }), mirrorApiExchange: async () => {},
      startTypingWithSafety: () => {}, lastMessageSource: new Map(), handleEventsRequest: () => new Response("events"), scheduleClearRotation: () => {},
    } as never);
  });
  beforeEach(async () => {
    failList = false;
    listed = [row("agent-worker"), row("agent-dead", "dead")];
    await touchRegistry();
    listCalls = 0;
  });

  describe("验收 1：连发 10 个 /pending", () => {
    it("并发 10 个：缓存期内只调 1 次 manager list（老实现 10 次）", async () => {
      const t0 = performance.now();
      const rs = await Promise.all(Array.from({ length: 10 }, () => pending("worker")));
      process.stderr.write(`[SYN4] 并发 10 个 /pending：list 调用 ${listCalls} 次，${(performance.now() - t0).toFixed(0)}ms\n`);
      expect(rs.map((r) => r.status)).toEqual(Array(10).fill(200));
      expect(listCalls).toBe(1);
    });

    it("顺序 10 个：同样只调 1 次", async () => {
      for (let i = 0; i < 10; i++) expect((await pending(i % 2 ? "worker" : "agent-worker")).status).toBe(200);
      process.stderr.write(`[SYN4] 顺序 10 个 /pending：list 调用 ${listCalls} 次\n`);
      expect(listCalls).toBe(1);
    });
  });

  describe("验收 2：找人结果与老实现一致", () => {
    it("worker ↔ agent-worker 互认，返回规范名", async () => {
      expect(await pending("worker")).toMatchObject({ status: 200, body: { ok: true, agent: "agent-worker" } });
      expect(await pending("agent-worker")).toMatchObject({ status: 200, body: { ok: true, agent: "agent-worker" } });
    });

    it("master 特判：不查名单", async () => {
      expect(await pending("master")).toMatchObject({ status: 200, body: { ok: true, agent: "master" } });
      expect(listCalls).toBe(0);
    });

    it("窗口没了的 active（list 里 status=dead）照样找得到", async () => {
      expect(await pending("dead")).toMatchObject({ status: 200, body: { agent: "agent-dead" } });
    });

    it("已停的 agent（registry 有、list 不列）→ 404；不存在 → 404", async () => {
      expect((await pending("gone")).status).toBe(404);
      expect((await pending("nobody")).status).toBe(404);
    });

    it("名单读不到 → 503 不冒充 404，且失败不缓存：恢复后下一次就能找到", async () => {
      failList = true;
      const r = await pending("worker");
      expect(r.status).toBe(503);
      expect(r.status).not.toBe(404);
      failList = false;
      expect((await pending("worker")).status).toBe(200);
      expect(listCalls).toBe(2);
    });
  });

  describe("验收 3：create / kill / rename 后立刻读到新状态", () => {
    it("create：registry 一写，新 agent 立刻找得到", async () => {
      expect((await pending("fresh")).status).toBe(404);
      registry["agent-fresh"] = { name: "agent-fresh", status: "active", channelId: "ch-agent-fresh", cwd: join(home, "w") };
      listed = [...listed, row("agent-fresh")];
      await touchRegistry();
      expect(await pending("fresh")).toMatchObject({ status: 200, body: { agent: "agent-fresh" } });
      expect(listCalls).toBe(2);
    });

    it("kill：registry 一写，被停的立刻 404", async () => {
      expect((await pending("worker")).status).toBe(200);
      registry["agent-worker"] = { ...registry["agent-worker"]!, status: "stopped" };
      listed = listed.filter((a) => a.name !== "agent-worker");
      await touchRegistry();
      expect((await pending("worker")).status).toBe(404);
      registry["agent-worker"] = { ...registry["agent-worker"]!, status: "active" };
    });

    it("rename：旧名立刻 404，新名立刻找得到", async () => {
      expect((await pending("worker")).status).toBe(200);
      const { ["agent-worker"]: w, ...rest } = registry;
      const renamed = { ...rest, "agent-worker2": { ...w!, name: "agent-worker2" } };
      writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: renamed }));
      listed = [row("agent-worker2"), row("agent-dead", "dead")];
      expect((await pending("worker")).status).toBe(404);
      expect(await pending("worker2")).toMatchObject({ status: 200, body: { agent: "agent-worker2" } });
    });
  });
}
