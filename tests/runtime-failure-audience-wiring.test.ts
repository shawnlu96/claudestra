/**
 * 回合失败卡的真实接线（lib/runtime-failure-audience.ts）：临时 registry / 台账 / 出借 journal + 假 ACP socket，走 onAcpFrame → openRuntimeAsk →
 * 台账里的 ask → 推送派发器的判定与实际发送，再走调度器 codexFailure → 退人工 → 通知 PM。派单会话的非 retry 回合错误：卡照开、
 * owner 推送 / 横幅为零、PM 照常收到；普通会话、名字像但没绑定、会话 / 项目对不上、登录 / 额度照旧推；retry 不开卡；重复帧、bridge 重启不变。
 * 子进程：env 只带隔离项，HOME / 状态 / 运行目录 / TMPDIR 都是临时的，bridge 地址指向死端口。
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testChildEnv } from "./test-env.ts";

async function probe() {
  const { writeFileSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { onAcpFrame } = await import("../src/bridge/acp-link.ts");
  const { setAsksForTest, onAsk } = await import("../src/bridge/asks.ts");
  const { resetRuntimeAsksForTest } = await import("../src/bridge/ask-runtime.ts");
  const { setExtensionSocket } = await import("../src/bridge/pi-abort.ts");
  const { createDispatcher } = await import("../src/bridge/push/dispatcher.ts");
  const { listAsks } = await import("../src/lib/ledger-asks.ts");
  const { openLendJournal } = await import("../src/lib/lend-journal.ts");
  const { normalizeRegistryAgents } = await import("../src/lib/registry.ts");
  const { saveApnsDevice, savePushSubscription } = await import("../src/lib/push-store.ts");
  const { openWebState } = await import("../src/lib/web-state.ts");
  const { codexFailure } = await import("../src/lib/scheduler-auto-ports.ts");
  const { boundRef } = await import("../src/lib/scheduler-auto-tick.ts");
  const { ledgerResult } = await import("../src/lib/scheduler-work-order.ts");
  const { createAcpWorker } = await import("../src/lib/worker-acp.ts");
  const { autoFixture, H1 } = await import("./scheduler-auto-helpers.ts");
  // 旧代码没有这个模块：探针照样跑完同一组断言（旧红新绿）
  const audience: any = await import("../src/lib/runtime-failure-audience.ts").catch(() => null);

  const ws = { sent: [] as unknown[], send(d: string) { this.sent.push(JSON.parse(d)); } };
  setExtensionSocket(() => ws, { deliver: async () => undefined, ownerId: () => "", books: () => ({}) as never,
    hold: () => { throw new Error("unexpected held echo"); } });
  const drain = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); await Bun.sleep(5); };
  const POLICY = "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.";

  async function scenario(name: string, o: {
    channel?: string; failure?: Record<string, unknown>; frames?: number; restart?: boolean;
    edit?: (agents: Record<string, any>) => void; lend?: { agent: string; state: string; sessionId: string };
  }) {
    const f = autoFixture();
    const ledgerPath = join(f.dir, "ledger.sqlite"), lendPath = join(f.dir, "lend.sqlite");
    const reg = () => JSON.parse(readFileSync(f.registryPath, "utf8"));
    const write = (r: any) => writeFileSync(f.registryPath, JSON.stringify(r));
    try {
      const r0 = reg();
      Object.assign(r0.agents["agent-rv-t1"], { channelId: "ch-rv", projectId: "p" });
      Object.assign(r0.agents["agent-task-one"], { projectId: "p" });
      r0.agents["agent-plain"] = { runtime: "codex", transport: "acp", sessionId: "s-plain", channelId: "ch-plain", projectId: "p", status: "active" };
      r0.agents["agent-lend-0123456789"] = { runtime: "codex", transport: "acp", sessionId: "s-lend", channelId: "ch-lend", kind: "worker", status: "active" };
      write(r0);
      const tickWorker = f.tickDeps.worker;
      f.tickDeps.worker = (ref) => ref.family === "codex" ? createAcpWorker({
        sessions: { bound: (t, role) => boundRef(f.db, t, role), create: async () => ({ ok: false, unknown: false, reason: "n/a" }), archive: async () => ({ ok: true, evidence: "x" }) },
        ledger: { result: (r, p) => ledgerResult(f.db, r, p) },
        port: { prompt: async () => ({ ok: true as const, messageId: "m" }), turnState: async (a) => ({ live: "idle", lastFailure: codexFailure(f.db, a) }),
          cancel: async () => ({ ok: true, evidence: "c" }) },
      }) : tickWorker(ref);
      await f.tick(); await f.tick(); // ensure author + restate order
      await f.cli("agent-task-one", "stage", "T1", "--from", "spec", "--to", "restate", "--text", "复述");
      await f.cli("pm", "restate-approve", "T1");
      await f.tick(); await f.tick(); // build order sent
      await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
      await f.tick(); // ensure reviewer
      const sent = await f.tick(); // review order claimed + sent to agent-rv-t1
      if (o.lend) {
        const j = openLendJournal(lendPath);
        j.query(`INSERT INTO lend_orders (orderId, peer, fp, family, state, preview, agent, sessionId, createdAt, updatedAt)
          VALUES ('lend:x:s1:r0:a0', 'peer:A', NULL, 'codex', ?, '{}', ?, ?, 1, 1)`).run(o.lend.state, o.lend.agent, o.lend.sessionId);
        j.close();
      }
      const r1 = reg();
      o.edit?.(r1.agents);
      write(r1);

      // owner 有一部 iPhone（APNs）和一个网页订阅；横幅那一路是 owner 正在用时派发器的判定
      const away = openWebState(":memory:"), here = openWebState(join(f.dir, "web-here.sqlite"));
      for (const db of [away, here]) {
        savePushSubscription(db, { endpoint: "https://push.example/ios", keys: { p256dh: "p", auth: "a" } }, "Mozilla/5.0 (iPhone)");
        saveApnsDevice(db, "ab".repeat(32), "iPhone", new Date(), { audience: "owner", principal: "owner:self" });
      }
      const pushed: unknown[] = [];
      const sender = { webPushKeys: () => ["K"], config: () => ({ mode: "direct", webPush: { vapidPublicKey: "K" }, apns: true }),
        sendWebPush: async (_s: unknown, p: string) => { pushed.push(JSON.parse(p)); return { ok: true, gone: false, status: 201 }; },
        sendApns: async (_t: unknown, m: unknown) => { pushed.push(m); return { ok: true, gone: false, status: 200 }; } };
      const quietSender = { ...sender, sendWebPush: async () => ({ ok: true, gone: false, status: 201 }), sendApns: async () => ({ ok: true, gone: false, status: 200 }) };
      const dAway = createDispatcher({ db: away, sender: sender as never, isOwnerChat: () => false, log: () => {} });
      const dHere = createDispatcher({ db: here, sender: quietSender as never, isOwnerChat: () => false, log: () => {} });
      const decisions: string[] = [], banners: string[] = [];
      const unsub = onAsk((a) => {
        void dAway.onAsk(a, "away").then((d) => decisions.push(`${a.id}:${a.state}:${d}`));
        void dHere.onAsk(a, "active").then((d) => d === "banner" && banners.push(`${a.id}:${a.state}`));
      });
      setAsksForTest({ path: ledgerPath, registry: normalizeRegistryAgents(reg()), ownerChats: [] });
      audience?.setFailureAudienceViewForTest(audience.audienceView({ registry: f.registryPath, ledger: ledgerPath, lend: lendPath }));
      resetRuntimeAsksForTest();

      const channelId = o.channel ?? "ch-rv";
      const failure = o.failure ?? { kind: "error", key: "turn-1", message: POLICY, retry: false };
      for (let n = 0; n < (o.frames ?? 1); n++) {
        await onAcpFrame({ type: "acp_failure", channelId, failure, label: "Codex" }, ws, {} as never);
        await drain();
      }
      if (o.restart) { // bridge 重启：内存表清空，宿主重报同一失败 → 认领台账里那张，不另开、不另推
        resetRuntimeAsksForTest();
        await onAcpFrame({ type: "acp_failure", channelId, failure, label: "Codex" }, ws, {} as never);
        await drain();
      }
      const asks = listAsks(f.db, {}).filter((a) => a.fromChannelId === channelId);
      const after = await f.tick();
      unsub();
      dAway.stop(); dHere.stop();
      return { name, sent: sent?.step, asks: asks.map((a) => ({ id: a.id, kind: a.kind, state: a.state, blocking: a.blocking, project: a.project, fromAgent: a.fromAgent,
        fromChannelId: a.fromChannelId, source: a.source, title: a.title, context: a.context, extra: a.extra })),
        pushed: pushed.length, decisions, banners, after: { step: after?.step, detail: after?.detail }, notices: [...f.notices],
        mode: (f.db.query("SELECT mode FROM task_workflows WHERE taskId = 'T1'").get() as { mode: string }).mode };
    } finally {
      audience?.setFailureAudienceViewForTest(undefined);
      setAsksForTest(undefined);
      f.close();
    }
  }

  const out = [];
  out.push(await scenario("bound reviewer policy error", {}));
  out.push(await scenario("plain owner session", { channel: "ch-plain" }));
  out.push(await scenario("session mismatch", { edit: (a) => { a["agent-rv-t1"].sessionId = "s-other"; } }));
  out.push(await scenario("project mismatch", { edit: (a) => { a["agent-rv-t1"].projectId = "q"; } }));
  out.push(await scenario("lend-like name without journal", { channel: "ch-lend" }));
  out.push(await scenario("lend journal other session", { channel: "ch-lend", lend: { agent: "agent-lend-0123456789", state: "started", sessionId: "s-old" } }));
  out.push(await scenario("lend bound worker", { channel: "ch-lend", lend: { agent: "agent-lend-0123456789", state: "started", sessionId: "s-lend" } }));
  out.push(await scenario("lend bound but kind not worker", { channel: "ch-lend", lend: { agent: "agent-lend-0123456789", state: "started", sessionId: "s-lend" },
    edit: (a) => { delete a["agent-lend-0123456789"].kind; } }));
  out.push(await scenario("auth on bound reviewer", { failure: { kind: "auth", message: "401" } }));
  out.push(await scenario("quota on bound reviewer", { failure: { kind: "quota", key: "q1", message: "Quota depleted" } }));
  out.push(await scenario("retry true", { failure: { kind: "error", key: "turn-1", message: POLICY, retry: true } }));
  out.push(await scenario("duplicate frames + restart", { frames: 2, restart: true }));
  return out;
}

test("派单会话的回合失败：卡照开、调度照常退人工通知 PM，owner 推送与横幅为零；其余会话 / 失败种类照旧", async () => {
  const root = mkdtempSync(join(tmpdir(), "rtf-audience-"));
  const dirs = Object.fromEntries(["home", "state", "runtime", "tmp"].map((d) => [d, join(root, d)]));
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", "./preload.ts", "-e",
      `console.log("PROBE=" + JSON.stringify(await (${probe.toString()})()));`], {
      cwd: import.meta.dir, stdout: "pipe", stderr: "pipe",
      env: testChildEnv({ HOME: dirs.home, TMPDIR: dirs.tmp, CLAUDESTRA_STATE_DIR: dirs.state, CLAUDESTRA_RUNTIME_DIR: dirs.runtime }),
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, err: exit ? stderr : "" }).toEqual({ exit: 0, err: "" });
    const out: any[] = JSON.parse(stdout.split("\n").find((s) => s.startsWith("PROBE="))!.slice(6));
    const by = Object.fromEntries(out.map((s) => [s.name, s]));

    // 派单审查员的策略拦截：卡照开（字段齐全），owner 零推送零横幅；调度器认到这张卡，退人工、通知 PM 一次
    const bound = by["bound reviewer policy error"];
    expect(bound.sent).toBe("sent");
    expect(bound.asks).toHaveLength(1);
    expect({ pushed: bound.pushed, banners: bound.banners }).toEqual({ pushed: 0, banners: [] });
    expect(bound.asks[0]).toMatchObject({ source: "codex", kind: "owner_action", state: "open", blocking: false, project: "p",
      fromAgent: "agent-rv-t1", fromChannelId: "ch-rv", title: "Codex 回合失败", context: expect.stringContaining("cybersecurity"),
      extra: { failure: "error", fp: expect.any(String) } });
    expect(bound.after.step).toBe("manual");
    expect(bound.mode).toBe("manual");
    expect(bound.notices).toHaveLength(1);
    expect(bound.notices[0]).toContain("cybersecurity");

    // 普通 owner 会话、身份 / 绑定对不上：原路推（不在 → 推送，在用 → 横幅）
    for (const name of ["plain owner session", "session mismatch", "project mismatch", "lend-like name without journal", "lend journal other session", "lend bound but kind not worker"]) {
      const s = by[name];
      expect({ name, n: s.asks.length, blocking: s.asks[0]?.blocking, failure: s.asks[0]?.extra.failure }).toEqual({ name, n: 1, blocking: true, failure: "error" });
      expect({ name, pushed: s.pushed > 0, banners: s.banners.length }).toEqual({ name, pushed: true, banners: 1 });
    }
    // 会话对不上的：调度器照旧（这张卡仍归这张单）退人工通知 PM，只是 owner 也收到
    expect(by["session mismatch"].notices).toHaveLength(1);

    // 出借 worker：registry 明写 kind=worker、journal 里在跑的单、会话对得上 → 不推
    const lend = by["lend bound worker"];
    expect(lend.asks).toHaveLength(1);
    expect(lend.asks[0]).toMatchObject({ kind: "owner_action", blocking: false, fromAgent: "agent-lend-0123456789", fromChannelId: "ch-lend", extra: { failure: "error" } });
    expect({ pushed: lend.pushed, banners: lend.banners }).toEqual({ pushed: 0, banners: [] });

    // 登录 / 额度：派单会话上也照旧推 owner
    expect(by["auth on bound reviewer"].asks[0]).toMatchObject({ kind: "owner_action", blocking: true, title: "Codex 需要 owner 登录" });
    expect(by["quota on bound reviewer"].asks[0]).toMatchObject({ kind: "decide", blocking: true, extra: { quota: true } });
    for (const name of ["auth on bound reviewer", "quota on bound reviewer"]) {
      expect({ name, pushed: by[name].pushed > 0, banners: by[name].banners.length }).toEqual({ name, pushed: true, banners: 1 });
    }

    // retry=true：不开卡、不推、调度不退人工
    expect(by["retry true"]).toMatchObject({ asks: [], pushed: 0, banners: [], mode: "auto" });

    // 同一失败重复帧、bridge 重启后重报：只有一张卡、零推送，调度照常退人工一次
    const dup = by["duplicate frames + restart"];
    expect(dup.asks).toHaveLength(1);
    expect({ pushed: dup.pushed, banners: dup.banners, step: dup.after.step, notices: dup.notices.length }).toEqual({ pushed: 0, banners: [], step: "manual", notices: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
