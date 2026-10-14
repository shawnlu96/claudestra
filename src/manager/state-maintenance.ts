/**
 * `manager state-maintenance` 内部子命令:维护面板按钮的系统入口(bridge 免 LLM 按钮直达,不拼命令)。
 *   status                       只读:档位、屏障、最近报告与运行(off 也能看,不建任何目录)
 *   observe | mode <档> | run <报告runId> | recover <runId> | note-retry   都要 --grant <bridge 签发的单次授权>
 * actor 只取授权里 bridge 判定的点击者,再按台账核「本卡项目 PM / owner」;off 下 observe / run 零副作用直接拒绝。
 * run 只提交已授权请求并拉起独立执行器(维护页就绪才停服务),返回 runId 与维护页入口。tests/state-maintenance-entry.test.ts。
 */

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { renameStateMode, setRenameStateMode, type RenameStateMode } from "../lib/config-store.js";
import { nodeStateFs } from "../lib/floka-migration/state/fs-adapter.js";
import { readBarrier } from "../lib/state-maintenance/barrier.js";
import { contextProblems, openMaintenance, productionContext, type MaintContext } from "../lib/state-maintenance/context.js";
import { rootsDigest } from "../lib/state-maintenance/executor.js";
import { consumeGrant, type GrantAction } from "../lib/state-maintenance/grant.js";
import { flushPendingNotes, maintenanceRoleRefusal, recordPointer } from "../lib/state-maintenance/ledger-access.js";
import { maintPaths, validRunId } from "../lib/state-maintenance/paths.js";
import { gitHead, packageVersion, spawnRunner } from "../lib/state-maintenance/real-deps.js";
import { buildObserveReport, sha256Hex, writeReport, type ObserveReport } from "../lib/state-maintenance/report.js";
import { bindReport, createRequest, loadState, readJson, runPaths } from "../lib/state-maintenance/run-store.js";
import { LEDGER_PATH } from "../lib/ledger-store.js";
import type { RunnerSpawnArgs } from "../state-maintenance-runner.js";
import { output } from "./core.js";

export interface CmdDeps {
  ctx: MaintContext;
  ledgerPath: string;
  /** 写结果指针用的台账(缺省同 ledgerPath;单测用它模拟指针落库失败) */
  pointerLedgerPath?: string;
  now: () => number;
  mode: () => RenameStateMode;
  setMode: (m: RenameStateMode) => Promise<unknown>;
  baseline: () => Promise<string>;
  version: string;
  /** 拉起独立 runner(生产:detached) */
  spawn: (args: RunnerSpawnArgs) => void;
  /** 等维护页就绪的上限 */
  readyWaitMs: number;
}

type Out = Record<string, unknown> & { ok: boolean };

const newRunId = (kind: "obs" | "run", now: number) => `${kind}-${new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${randomBytes(3).toString("hex")}`;

function grantFlag(args: string[]): { rest: string[]; grant: string | null } {
  const i = args.indexOf("--grant");
  if (i < 0) return { rest: args, grant: null };
  return { rest: [...args.slice(0, i), ...args.slice(i + 2)], grant: args[i + 1] ?? null };
}

/** 消费授权 + 核角色;actor 只认授权里记的 */
function authorize(d: CmdDeps, grant: string | null, action: GrantAction, binding: Record<string, string>): { actor: string } | { error: string } {
  if (!grant) return { error: "缺少单次授权:只能经维护面板按钮触发" };
  const g = consumeGrant(d.ctx.maintRoot, grant, action, binding, d.now());
  if (!g.ok) return { error: g.error };
  const refusal = maintenanceRoleRefusal(g.grant.actor, d.ledgerPath);
  return refusal ? { error: refusal } : { actor: g.grant.actor };
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).filter(validRunId).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/** 最近一份 observe 报告(相对路径 + 哈希 + 摘要) */
function latestReport(root: string): { runId: string; rel: string; sha256: string; snapshot: string; conflicts: number; createdAt: string } | null {
  for (const runId of listDir(maintPaths(root).reports).reverse()) {
    const rel = `reports/${runId}/observe.json`;
    if (!existsSync(join(root, rel))) continue;
    const text = readFileSync(join(root, rel), "utf8");
    const r = JSON.parse(text) as ObserveReport;
    return { runId, rel, sha256: sha256Hex(text), snapshot: r.snapshot, conflicts: r.conflicts.length, createdAt: r.createdAt };
  }
  return null;
}

function status(d: CmdDeps): Out {
  const root = d.ctx.maintRoot;
  const runs = listDir(join(maintPaths(root).control, "runs")).slice(-5).map((id) => {
    const s = loadState(root, id);
    return { runId: id, phase: s?.phase ?? "unknown", outcome: s?.outcome ?? null, noteOk: s?.note?.ok ?? null };
  });
  const barrier = existsSync(root) ? readBarrier(root) : null;
  const pending = existsSync(join(maintPaths(root).control, "pending-notes")) ? readdirSync(join(maintPaths(root).control, "pending-notes")).length : 0;
  return { ok: true, mode: d.mode(), problems: contextProblems(d.ctx), barrier, latestReport: existsSync(root) ? latestReport(root) : null, runs, pendingNotes: pending };
}

async function observe(d: CmdDeps, grant: string | null): Promise<Out> {
  const mode = d.mode();
  if (mode === "off") return { ok: false, error: "rename.state 是 off:不预演、不建报告" };
  openMaintenance(d.ctx);
  const auth = authorize(d, grant, "observe", {});
  if ("error" in auth) return { ok: false, error: auth.error };
  const runId = newRunId("obs", d.now());
  const report = await buildObserveReport({ ...d.ctx, fs: nodeStateFs, runId, mode, version: d.version, baseline: await d.baseline(), now: d.now() });
  const saved = writeReport(d.ctx.maintRoot, runId, "observe", report);
  const result = report.conflicts.length ? `有 ${report.conflicts.length} 处冲突` : report.snapshot;
  const note = recordPointer(d.ctx.maintRoot, { op: "state_maintenance_observe", version: d.version, runId, mode, result,
    reportRel: saved.rel, reportSha256: saved.sha256, actor: auth.actor }, d.pointerLedgerPath ?? d.ledgerPath);
  return {
    ok: note.ok, runId, report: saved.rel, reportSha256: saved.sha256, snapshot: report.snapshot, conflicts: report.conflicts,
    ...(note.ok ? {} : { error: `报告已存,ledger 指针留存未完成:${note.error}(恢复按钮可补记)` }),
  };
}

async function setMode(d: CmdDeps, grant: string | null, want: string | undefined): Promise<Out> {
  if (want !== "off" && want !== "observe" && want !== "on") return { ok: false, error: "档位只能是 off / observe / on" };
  openMaintenance(d.ctx);
  const auth = authorize(d, grant, "mode", { mode: want });
  if ("error" in auth) return { ok: false, error: auth.error };
  await d.setMode(want);
  return { ok: true, mode: want, note: "只切档,不触发任何迁移;执行要另由按钮批准维护窗口" };
}

/** 等 serve 进程把维护页起好、状态 ready(或恢复时写出访问码),取走访问码 */
async function waitPage(d: CmdDeps, runId: string): Promise<string | null> {
  const p = runPaths(d.ctx.maintRoot, runId);
  const deadline = d.now() + d.readyWaitMs;
  while (d.now() < deadline) {
    const access = readJson<{ port: number; code: string }>(p.access);
    if (access) {
      unlinkSync(p.access);
      return `http://127.0.0.1:${access.port}/?code=${access.code}`;
    }
    await Bun.sleep(200);
  }
  return null;
}

async function run(d: CmdDeps, grant: string | null, reportRunId: string | undefined, reportSha: string | undefined): Promise<Out> {
  if (d.mode() !== "on") return { ok: false, error: "rename.state 不是 on:不执行迁移" };
  if (!reportRunId || !validRunId(reportRunId) || !reportSha) return { ok: false, error: "要给批准的报告 runId 与哈希" };
  openMaintenance(d.ctx);
  const auth = authorize(d, grant, "run", { reportRunId, reportSha256: reportSha });
  if ("error" in auth) return { ok: false, error: auth.error };
  const rel = `reports/${reportRunId}/observe.json`;
  let text: string;
  try {
    text = readFileSync(join(d.ctx.maintRoot, rel), "utf8");
  } catch {
    return { ok: false, error: "批准的报告不存在" }; // 没有报告就没有可绑定的对象
  }
  if (sha256Hex(text) !== reportSha) return { ok: false, error: "报告与批准时不一致,拒绝" };
  if ((JSON.parse(text) as ObserveReport).conflicts.length) return { ok: false, error: "报告有冲突,拒绝执行" };
  const runId = newRunId("run", d.now());
  if (!bindReport(d.ctx.maintRoot, reportRunId, runId)) return { ok: false, error: "这份报告已经发起过执行,不重复迁移;请重新预演" };
  createRequest(d.ctx.maintRoot, {
    runId, actor: auth.actor, reportRunId, reportRel: rel, reportSha256: reportSha, baseline: await d.baseline(),
    rootsDigest: rootsDigest(d.ctx.oldRoot, d.ctx.newRoot), createdAt: d.now(), expiresAt: d.now() + 10 * 60_000,
  });
  d.spawn(["serve", runId]);
  const page = await waitPage(d, runId);
  return page ? { ok: true, runId, page } : { ok: false, runId, error: "维护页没在时限内就绪,执行器不会停服务;可在面板看状态" };
}

async function recover(d: CmdDeps, grant: string | null, runId: string | undefined): Promise<Out> {
  if (!runId || !validRunId(runId)) return { ok: false, error: "要给 runId" };
  openMaintenance(d.ctx);
  const auth = authorize(d, grant, "recover", { runId });
  if ("error" in auth) return { ok: false, error: auth.error };
  if (!loadState(d.ctx.maintRoot, runId)) return { ok: false, error: "没有这次运行" };
  d.spawn(["serve", runId, "--recover"]);
  const page = await waitPage(d, runId);
  return page ? { ok: true, runId, page } : { ok: false, runId, error: "恢复页没在时限内就绪" };
}

function noteRetry(d: CmdDeps, grant: string | null): Out {
  openMaintenance(d.ctx);
  const auth = authorize(d, grant, "note", {});
  if ("error" in auth) return { ok: false, error: auth.error };
  const r = flushPendingNotes(d.ctx.maintRoot, d.ledgerPath);
  return r.failed.length ? { ok: false, done: r.done, error: `仍有 ${r.failed.length} 条没补上:${r.failed.join(";")}` } : { ok: true, done: r.done };
}

export async function stateMaintenance(argv: string[], d: CmdDeps): Promise<Out> {
  const { rest, grant } = grantFlag(argv);
  const [sub, a, b] = rest;
  try {
    if (sub === "status") return status(d);
    if (sub === "observe") return await observe(d, grant);
    if (sub === "mode") return await setMode(d, grant, a);
    if (sub === "run") return await run(d, grant, a, b);
    if (sub === "recover") return await recover(d, grant, a);
    if (sub === "note-retry") return noteRetry(d, grant);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: false, error: "用法:state-maintenance status | observe | mode <off|observe|on> | run <报告runId> <报告哈希> | recover <runId> | note-retry(都要 --grant)" };
}

/** 机器认主:热备副本上不跑维护(lib/owner-guard.ts) */
async function ownerRefusal(): Promise<string | null> {
  const { readOwnerMarker, ownerVerdict, machineUuid } = await import("../lib/owner-guard.js");
  const v = ownerVerdict(readOwnerMarker(), { uuid: machineUuid(), host: (await import("node:os")).hostname() }, false);
  return v.ok ? null : "本机不是这套 Claudestra 的主机,拒绝状态根维护";
}

export async function cmdStateMaintenance(argv: string[]): Promise<void> {
  if (argv[0] !== "status") {
    const no = await ownerRefusal();
    if (no) return output({ ok: false, error: no });
  }
  output(await stateMaintenance(argv, {
    ctx: productionContext(), ledgerPath: LEDGER_PATH, now: () => Date.now(), mode: () => renameStateMode(), setMode: setRenameStateMode,
    baseline: gitHead, version: packageVersion(), spawn: (args) => spawnRunner(productionContext().maintRoot, args), readyWaitMs: 30_000,
  }));
}
