/**
 * 正式入口与档位:按钮 HMAC → bridge 签发单次授权 → manager 子命令(核授权与台账角色)→ 报告 / 指针 / 独立执行器。
 * 全部在 /tmp 下的隔离 home、隔离台账里跑;执行器子进程带测试标记,碰不到真实 launchd / tmux。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { handleStateMaintButton, macFor, panelFor, parseButton } from "../src/bridge/state-maintenance-buttons.ts";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.ts";
import { createTask, setMeta } from "../src/lib/ledger-write.ts";
import { openMaintenance, type MaintContext } from "../src/lib/state-maintenance/context.ts";
import { consumeGrant, issueGrant, type GrantAction } from "../src/lib/state-maintenance/grant.ts";
import { maintenanceRoleRefusal, recordPointer } from "../src/lib/state-maintenance/ledger-access.ts";
import { maintenanceRoot } from "../src/lib/state-maintenance/paths.ts";
import { loadState, runPaths } from "../src/lib/state-maintenance/run-store.ts";
import { stateMaintenance, type CmdDeps } from "../src/manager/state-maintenance.ts";

const PEM = String(generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }));
const bases: string[] = [];
const servePids: number[] = [];
afterEach(() => {
  for (const p of servePids.splice(0)) try { process.kill(p); } catch { /* serve 已自行退出 */ }
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

interface Fx { ctx: MaintContext; ledger: string; mode: { v: "off" | "observe" | "on" }; spawned: string[][] }

function fixture(opts: { card?: boolean; ledgerInRoot?: boolean } = {}): Fx {
  const home = mkdtempSync(join(realpathSync("/tmp"), "smaint-entry-"));
  bases.push(home);
  const oldRoot = join(home, ".claude-orchestrator");
  mkdirSync(oldRoot, { mode: 0o700 });
  writeFileSync(join(oldRoot, "instance-id"), "a1b2c3d4e5f6\n", { mode: 0o600 });
  writeFileSync(join(oldRoot, "instance-key.pem"), PEM, { mode: 0o600 });
  const ledger = opts.ledgerInRoot ? join(oldRoot, "ledger.sqlite") : join(home, "ledger-outside.sqlite");
  if (opts.card !== false) seedCard(ledger);
  const ctx = { home, oldRoot, newRoot: join(home, ".floka"), maintRoot: maintenanceRoot(home) };
  return { ctx, ledger, mode: { v: "observe" }, spawned: [] };
}

function seedCard(path: string): void {
  const db = openLedger(path);
  createTask(db, { actor: "owner" }, { project: "claudestra", id: "rename-floka-STATE2", title: "STATE2", kind: "code", agent: "agent-worker" });
  setMeta(db, { actor: "owner" }, { project: "claudestra", key: "pms", value: ["agent-claudestra"] });
  closeLedger(path);
}

function deps(fx: Fx, over: Partial<CmdDeps> = {}): CmdDeps {
  return {
    ctx: fx.ctx, ledgerPath: fx.ledger, now: () => Date.now(), mode: () => fx.mode.v, setMode: async (m) => void (fx.mode.v = m),
    baseline: async () => "base1", version: "test", spawn: (a) => void fx.spawned.push(a), readyWaitMs: 300, ...over,
  };
}

const grant = (fx: Fx, action: GrantAction, binding: Record<string, string> = {}, actor = "owner") => {
  openMaintenance(fx.ctx);
  return issueGrant(fx.ctx.maintRoot, { action, actor, binding });
};

/** 状态根逐项快照(权限 + 内容),用来证明零写入 */
function snapshot(root: string): string {
  const out: string[] = [];
  const walk = (p: string) => {
    const st = lstatSync(p);
    out.push(`${p}:${st.mode}:${st.isFile() ? readFileSync(p, "base64") : ""}`);
    if (st.isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n));
  };
  walk(root);
  return out.join("\n");
}

const notes = (fx: Fx) => {
  const db = openLedger(fx.ledger);
  try {
    return listEvents(db, { project: "claudestra" }).filter((e) => e.kind === "note");
  } finally {
    closeLedger(fx.ledger);
  }
};

describe("[验收线 1] 单次授权与角色", () => {
  test("伪造、重放、用错动作、绑定不符、过期都拒绝;每个授权只能用一次", () => {
    const fx = fixture();
    const root = fx.ctx.maintRoot;
    const t = grant(fx, "run", { reportRunId: "obs-1" });
    expect(consumeGrant(root, "x".repeat(43), "run", {}).ok).toBe(false);
    expect(consumeGrant(root, t, "observe", {}).ok).toBe(false);
    expect(consumeGrant(root, t, "run", { reportRunId: "obs-1" }).ok).toBe(false); // 上一次用错动作已经把它作废
    const t2 = grant(fx, "run", { reportRunId: "obs-1" });
    expect(consumeGrant(root, t2, "run", { reportRunId: "obs-2" }).ok).toBe(false);
    const t3 = grant(fx, "mode", { mode: "on" });
    expect(consumeGrant(root, t3, "mode", { mode: "on" }, Date.now() + 10 * 60_000).ok).toBe(false);
    const t4 = grant(fx, "observe");
    expect(consumeGrant(root, t4, "observe", {}).ok).toBe(true);
    expect(consumeGrant(root, t4, "observe", {}).ok).toBe(false);
  });

  test("只给本项目 PM / owner:master(调度助理)、执行者、别的 agent 一律拒绝", () => {
    const fx = fixture();
    expect(maintenanceRoleRefusal("owner", fx.ledger)).toBeNull();
    expect(maintenanceRoleRefusal("agent-claudestra", fx.ledger)).toBeNull();
    for (const who of ["master", "agent-worker", "agent-other", "scheduler"]) expect(maintenanceRoleRefusal(who, fx.ledger)).toContain("拒绝");
  });

  test("manager 不接受自报 actor:没授权、授权给了别人(master)都拒绝,且不产生报告", async () => {
    const fx = fixture();
    expect((await stateMaintenance(["observe"], deps(fx))).error).toContain("缺少单次授权");
    const r = await stateMaintenance(["observe", "--grant", grant(fx, "observe", {}, "master")], deps(fx));
    expect(r.error).toContain("拒绝");
    expect(readdirSync(join(fx.ctx.maintRoot, "reports"))).toEqual([]);
  });

  test("按钮 id 带 bridge 内存密钥的 HMAC:agent 自己贴的同名按钮(或别的频道)核不过", () => {
    const key = new Uint8Array(32).fill(7);
    const id = `smaint:observe::${macFor(key, "chan-1", "observe", "")}`;
    expect(parseButton(id, "chan-1", key)).toEqual({ action: "observe", arg: "" });
    expect(parseButton(id, "chan-2", key)).toBeNull();
    expect(parseButton("smaint:observe::00000000000000000000", "chan-1", key)).toBeNull();
    expect(parseButton(`smaint:shell:rm:${macFor(key, "chan-1", "shell", "rm")}`, "chan-1", key)).toBeNull();
  });
});

describe("[验收线 1] 档位:off 零副作用,observe 状态根零写入", () => {
  test("off:状态只读、不建维护根;observe / run 直接拒绝,不建报告、journal、锁", async () => {
    const fx = fixture();
    fx.mode.v = "off";
    const before = snapshot(fx.ctx.oldRoot);
    const s = await stateMaintenance(["status"], deps(fx));
    expect(s).toMatchObject({ ok: true, mode: "off", latestReport: null, runs: [] });
    expect((await stateMaintenance(["observe", "--grant", "x"], deps(fx))).ok).toBe(false);
    expect((await stateMaintenance(["run", "obs-1", "abc", "--grant", "x"], deps(fx))).ok).toBe(false);
    expect(existsSync(join(fx.ctx.home, ".claudestra-maintenance"))).toBe(false);
    expect(snapshot(fx.ctx.oldRoot)).toBe(before);
    const panel = panelFor(s as never, "chan-1");
    expect(JSON.stringify(panel.components)).not.toContain("observe::");
  });

  test("observe:状态根零写入;报告落在固定维护根(0700 / 0600),ledger 只多一条完整指针,不含路径与私钥", async () => {
    const fx = fixture();
    const before = snapshot(fx.ctx.oldRoot);
    const r = await stateMaintenance(["observe", "--grant", grant(fx, "observe")], deps(fx));
    expect(r.ok).toBe(true);
    expect(snapshot(fx.ctx.oldRoot)).toBe(before);
    expect(existsSync(fx.ctx.newRoot)).toBe(false);
    const path = join(fx.ctx.maintRoot, String(r.report));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(fx.ctx.maintRoot, "reports", String(r.runId))).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(fx.ctx.maintRoot, "journals"))).toEqual([]);
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain(fx.ctx.home);
    expect(text).not.toContain(PEM.split("\n")[1]!);
    const rep = JSON.parse(text);
    expect(rep.identity.items.find((i: { name: string }) => i.name === "signing-key").sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rep.identity.items.find((i: { name: string }) => i.name === "machine-key").status).toBe("missing");
    expect(rep.plannedSteps.map((s: { id: string }) => s.id)).toEqual(["state-move", "state-alias"]);
    expect(rep.notes.join()).toContain("不得作为 on 的停写前置证据");
    const [n] = notes(fx);
    expect(n!.data).toMatchObject({ op: "state_maintenance_observe", version: "test", runId: r.runId, mode: "observe", reportRel: r.report, reportSha256: r.reportSha256 });
    expect(JSON.stringify(n)).not.toContain(fx.ctx.home);
  });

  test("ledger 指针写失败:报「留存未完成」、不显示完整成功;补记按钮幂等补上", async () => {
    const fx = fixture();
    const r = await stateMaintenance(["observe", "--grant", grant(fx, "observe")], deps(fx, { pointerLedgerPath: join(fx.ctx.home, "no-card.sqlite") }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("留存未完成");
    expect(existsSync(join(fx.ctx.maintRoot, String(r.report)))).toBe(true);
    const retry = await stateMaintenance(["note-retry", "--grant", grant(fx, "note")], deps(fx));
    expect(retry).toMatchObject({ ok: true, done: 1 });
    expect(notes(fx)).toHaveLength(1);
    expect((await stateMaintenance(["note-retry", "--grant", grant(fx, "note")], deps(fx)))).toMatchObject({ ok: true, done: 0 });
  });

  test("同一 run 的新结果(seq 2)另记一条指针,旧指针不被去重吞掉或覆盖;同版重写幂等", () => {
    const fx = fixture();
    const base = { op: "state_maintenance_run" as const, version: "test", runId: "run-1", mode: "on", actor: "owner" };
    const v1 = { ...base, seq: 1, result: "failed", reportRel: "reports/run-1/run.json", reportSha256: "a".repeat(64) };
    const v2 = { ...base, seq: 2, result: "rolled-back", reportRel: "reports/run-1/run-2.json", reportSha256: "b".repeat(64) };
    expect(recordPointer(fx.ctx.maintRoot, v1, fx.ledger).ok).toBe(true);
    expect(recordPointer(fx.ctx.maintRoot, v2, fx.ledger).ok).toBe(true);
    expect(recordPointer(fx.ctx.maintRoot, v2, fx.ledger).ok).toBe(true);
    expect(notes(fx).map((n) => [(n.data as { result: string }).result, (n.data as { reportSha256: string }).reportSha256])).toEqual([
      ["failed", v1.reportSha256], ["rolled-back", v2.reportSha256],
    ]);
  });

  test("切档与执行分开:切到 on 不触发任何迁移;on 也要另经批准报告才发起执行", async () => {
    const fx = fixture();
    expect((await stateMaintenance(["mode", "on", "--grant", grant(fx, "mode", { mode: "observe" })], deps(fx))).ok).toBe(false);
    expect((await stateMaintenance(["mode", "on", "--grant", grant(fx, "mode", { mode: "on" })], deps(fx))).ok).toBe(true);
    expect(fx.mode.v).toBe("on");
    expect(existsSync(join(fx.ctx.maintRoot, "control", "runs"))).toBe(false);
    expect(fx.spawned).toEqual([]);
    expect(existsSync(fx.ctx.newRoot)).toBe(false);
  });
});

describe("[验收线 1] 真实链路:按钮 → manager → 独立执行器", () => {
  test("面板按钮经 HMAC + 授权调 manager;run 拉起独立 runner,维护页就绪后执行器起跑(测试进程只会走到拒绝)", async () => {
    const fx = fixture({ ledgerInRoot: true });
    fx.mode.v = "on";
    writeFileSync(join(fx.ctx.oldRoot, "config.json"), JSON.stringify({ rename: { state: "on" } }));
    const env = { ...process.env, HOME: fx.ctx.home, CLAUDESTRA_STATE_DIR: fx.ctx.oldRoot };
    const runner = join(import.meta.dir, "../src/state-maintenance-runner.ts");
    const head = (await new Response(Bun.spawn(["git", "-C", join(import.meta.dir, ".."), "rev-parse", "HEAD"], { stdout: "pipe" }).stdout).text()).trim();
    const d = deps(fx, {
      baseline: async () => head, readyWaitMs: 15_000,
      spawn: (a) => spawn(process.execPath, [runner, ...a], { detached: true, stdio: "ignore", cwd: fx.ctx.home, env }).unref(),
    });
    const runManager = async (cmd: string, ...args: string[]) => (cmd === "state-maintenance" ? await stateMaintenance(args, d) : { ok: false });
    await stateMaintenance(["observe", "--grant", grant(fx, "observe")], d);
    const panel = await handleStateMaintButton("smaint:panel", "chan-1", runManager, fx.ctx);
    const ask = (panel.components![0].buttons as { id: string }[]).find((b) => b.id.startsWith("smaint:runask:"))!;
    const confirm = await handleStateMaintButton(ask.id, "chan-1", runManager, fx.ctx);
    const go = (confirm.components![0].buttons as { id: string }[])[0]!;
    const done = await handleStateMaintButton(go.id, "chan-1", runManager, fx.ctx);
    const out = JSON.parse(done.text.replace(/^✅ /, ""));
    servePids.push(Number(readFileSync(runPaths(fx.ctx.maintRoot, out.runId).servePid, "utf8")));
    expect(out.page).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?code=/);
    let s = loadState(fx.ctx.maintRoot, out.runId);
    for (let i = 0; i < 100 && s?.phase !== "refused"; i++) await Bun.sleep(100), (s = loadState(fx.ctx.maintRoot, out.runId));
    expect(s!.history.map((h) => h.phase).slice(0, 2)).toEqual(["starting", "ready"]);
    expect(s!.phase).toBe("refused");
    expect(s!.error).toContain("测试进程不碰真实 launchd");
    expect(lstatSync(fx.ctx.oldRoot).isDirectory()).toBe(true);
    const again = await handleStateMaintButton(go.id, "chan-1", runManager, fx.ctx);
    expect(again.text).toContain("❌"); // 同一份报告不能再发起第二次执行
  }, 30_000);
});
