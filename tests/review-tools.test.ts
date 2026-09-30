/**
 * T97 两个审查员工具走完整管道：bridge handler（review-tools.ts）→ 写台账出口（order-ledger-exit.ts）→ `ledger submit-verdict`
 * （在「manager」一侧按频道认 actor、按 registry 核会话 / 家族，再重算判定）。出口用进程内的 runLedger 代替子进程。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewToolHandlers } from "../src/bridge/review-tools.js";
import { writeOneShot } from "../src/lib/caller-cred.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { createTask, deliver, setMeta, setTask } from "../src/lib/ledger-write.js";
import type { LedgerRun } from "../src/lib/order-ledger-exit.js";
import type { VerifiedCall } from "../src/lib/order-tool-route.js";
import { isOrderTool } from "../src/lib/order-tools.js";
import { reviewsDir } from "../src/lib/review-order.js";
import { issueVerdictTicket } from "../src/lib/verdict-ticket.js";
import { resolveActor } from "../src/manager/ledger-identity.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const H1 = "c".repeat(40);
const OWNER = { actor: "owner", now: 1_000 };
const agents: Record<string, { channelId: string; sessionId: string; runtime: string }> = {
  "agent-x": { channelId: "ch-x", sessionId: "sx", runtime: "claude-code" },
  "agent-y": { channelId: "ch-y", sessionId: "sy", runtime: "codex" },
};
let db: Database, dir: string, report: string, runs: string[][];

const run: LedgerRun = async (args, channelId) => {
  runs.push(args);
  const who = resolveActor({ channelId }, agents);
  if (!who.ok) return { ok: false, code: "forbidden", error: who.error };
  return runLedger(args.slice(1), { db, actor: who.actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents }) as never,
    saveRegistry: async () => {}, now: () => 3_000 });
};
const handlers = () => reviewToolHandlers(run, { get: () => db });
const Y: VerifiedCall = { agent: "agent-y", sessionId: "sy", family: "codex", channelId: "ch-y" };
const wire = (over: Record<string, unknown> = {}) => ({ v: 1, orderId: "T60:review:r1", head: H1, verdict: "changes", p0: 0, p1: 1, p2: 0,
  findings: [{ findingId: "F1", family: "gate", severity: "P1", probe: "复现", description: "说明" }], reportPath: report, ...over });
const reviews = () => listEvents(db, { project: P, target: "T60" }).filter((e) => e.kind === "review");

beforeEach(() => {
  runs = [];
  dir = mkdtempSync(join(tmpdir(), "t97-tools-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  mkdirSync(reviewsDir(), { recursive: true });
  report = join(reviewsDir(), `T60-r1-${Date.now()}.md`);
  writeFileSync(report, "# 结论\n");
  setMeta(db, OWNER, { project: P, key: "pms", value: ["agent-pm"] });
  createTask(db, OWNER, { project: P, id: "T60", title: "卡", kind: "code" });
  setTask(db, OWNER, { id: "T60", rev: 1, patch: { agent: "agent-x" } });
  assignStep(db, { actor: "agent-pm", now: 1_100 }, { taskId: "T60", step: "write", executor: "agent-x", executorKind: "agent" });
  db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T60'");
  deliver(db, { actor: "agent-x", now: 1_200 }, { taskId: "T60", headSHA: H1, moveFrom: "build" });
  assignStep(db, { actor: "agent-pm", now: 1_300 }, { taskId: "T60", step: "review", executor: "agent-y", executorKind: "agent" });
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
  rmSync(report, { force: true });
});

describe("审查员工具走完整管道", () => {
  test("两个工具都登记在 channel-server 的派单工具表里", () => {
    expect(isOrderTool("take_review") && isOrderTool("submit_verdict")).toBe(true);
  });

  test("take_review → submit_verdict：manager 一侧以调用方身份记结构化结论，不推阶段；重试不重记", async () => {
    const t = await handlers().take_review!(Y, {});
    expect(t).toMatchObject({ ok: true, orders: [{ orderId: "T60:review:r1", head: H1 }] });
    const r = await handlers().submit_verdict!(Y, wire());
    expect(r).toMatchObject({ ok: true, duplicate: false, taskId: "T60", sameFamily: false });
    expect(runs[0]!.slice(0, 3)).toEqual(["ledger", "submit-verdict", "T60:review:r1"]);
    expect(runs[0]).toContain(`--dedup=verdict:T60:review:r1@${H1}`);
    const [e] = reviews();
    expect(e!.actor).toBe("agent-y");
    expect(e!.data).toMatchObject({ reviewer: "agent-y", head: H1, reviewerSessionId: "sy", reviewerFamily: "codex", path: report, via: "mcp" });
    expect(getTask(db, "T60")!.stage).toBe("review");
    expect(await handlers().submit_verdict!(Y, wire())).toMatchObject({ ok: true, duplicate: true });
    expect(reviews().length).toBe(1);
  });

  test("wire 不合法 / 身份缺会话：bridge 当场拒，不起 manager", async () => {
    expect(await handlers().submit_verdict!(Y, wire({ p1: 0 }))).toMatchObject({ ok: false, code: "invalid_wire" });
    expect(await handlers().submit_verdict!({ ...Y, family: "pi" }, wire())).toMatchObject({ ok: false, code: "identity_incomplete" });
    expect(await handlers().submit_verdict!({ ...Y, sessionId: null }, wire())).toMatchObject({ ok: false, code: "identity_incomplete" });
    expect(runs).toEqual([]);
  });

  test("会话和 registry 当前值对不上（换过会话 / 手敲自报）：manager 拒，不记", async () => {
    expect(await handlers().submit_verdict!({ ...Y, sessionId: "stale" }, wire())).toMatchObject({ ok: false, code: "forbidden" });
    expect(await handlers().submit_verdict!({ ...Y, family: "claude-code" }, wire())).toMatchObject({ ok: false, code: "forbidden" });
    expect(reviews()).toEqual([]);
  });

  test("照旧习惯在 shell 里直接跑 ledger submit-verdict（没有票据 / 重放 / 别人的票据 / 挪到另一张 wire）：拒，不记", async () => {
    const w = JSON.stringify(wire());
    const direct = ["ledger", "submit-verdict", "T60:review:r1", `--wire=${w}`, "--session=sy", "--family=codex"];
    expect(await run(direct, "ch-y")).toMatchObject({ ok: false, code: "forbidden" });
    let seen: string[] = [];
    await reviewToolHandlers(async (args, ch) => ((seen = args), run(args, ch)), { get: () => db }).submit_verdict!(Y, wire());
    expect(await run(seen, "ch-y")).toMatchObject({ ok: false, code: "forbidden" }); // 票据文件已被第一次读走
    const forged = issueVerdictTicket("agent-x", w);
    expect(await run([...direct, `--ticket-file=${forged.file}`, `--ticket=${forged.proof}`], "ch-y")).toMatchObject({ ok: false, code: "forbidden" });
    const other = issueVerdictTicket("agent-y", JSON.stringify(wire({ verdict: "block", p0: 1, p1: 0,
      findings: [{ findingId: "F9", family: "gate", severity: "P0", probe: "复现", description: "说明" }] })));
    expect(await run([...direct, `--ticket-file=${other.file}`, `--ticket=${other.proof}`], "ch-y")).toMatchObject({ ok: false, code: "forbidden" }); // 票据挪到另一张 wire
    expect(reviews().length).toBe(1);
  });

  test("已知限制（不是安全边界）：同用户进程照格式自造票据能记上——manager 没有独立来源可比对，见 lib/verdict-ticket.ts", async () => {
    const w = JSON.stringify(wire());
    const token = randomBytes(32).toString("hex");
    const proof = createHash("sha256").update(`${token}\nagent-y\n${w}`, "utf8").digest("hex");
    const args = ["ledger", "submit-verdict", "T60:review:r1", `--wire=${w}`, "--session=sy", "--family=codex", `--ticket-file=${writeOneShot(token)}`, `--ticket=${proof}`];
    expect(await run(args, "ch-y")).toMatchObject({ ok: true, duplicate: false });
    expect(reviews().length).toBe(1);
  });

  test("不是本步骤审查员 / 自审：manager 重算后拒", async () => {
    const X: VerifiedCall = { agent: "agent-x", sessionId: "sx", family: "claude-code", channelId: "ch-x" };
    expect(await handlers().take_review!(X, {})).toEqual({ ok: true, orders: [], errors: [] });
    expect(await handlers().submit_verdict!(X, wire())).toMatchObject({ ok: false, code: "no_order" });
    assignStep(db, { actor: "agent-pm", now: 1_400 }, { taskId: "T60", step: "review", executor: "agent-x", executorKind: "agent" });
    expect(await handlers().submit_verdict!(X, wire())).toMatchObject({ ok: false, code: "self_review" });
    expect(reviews()).toEqual([]);
  });
});
