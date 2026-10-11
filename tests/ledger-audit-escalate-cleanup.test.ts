/**
 * dispatch-recovery-AUDESC1F：坏确认标记清理的两处兜底（AUDESC1 第 6 轮审查 stale-clean-race / marker-undeletable）。
 * 文件操作经 setAuditEscalatePorts({ fs }) 注入钩子：在「读到不合法」与「删除」之间同步跑完另一个确认者，不靠 sleep。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ackEscalations, auditEscalations, type EscalateFsPort, setAuditEscalatePorts } from "../src/lib/ledger-audit-escalate.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage, setMeta } from "../src/lib/ledger-write.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";
import { baselineAudit, tempLedgerPath } from "./ledger-test-helpers.js";

const MIN = 60_000;
const T0 = 1_000 * MIN;
const P = "claude-orchestrator";
const DIS = "agent-pm-dispatch";
const realFs: EscalateFsPort = { link: linkSync, rename: renameSync, unlink: unlinkSync };

let dir: string, path: string, db: Database, statePath: string, markers: string;
let hook: Partial<EscalateFsPort> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-audit-escalate-cleanup-"));
  path = tempLedgerPath("ledger-audit-escalate-cleanup-db-");
  statePath = join(dir, "audit-escalations.json");
  markers = `${statePath}.d`;
  db = openLedger(path);
  hook = {};
  const fs: EscalateFsPort = {
    link: (a, b) => (hook.link ?? realFs.link)(a, b),
    rename: (a, b) => (hook.rename ?? realFs.rename)(a, b),
    unlink: (a) => (hook.unlink ?? realFs.unlink)(a),
  };
  setAuditEscalatePorts({ policy: () => ({ mode: "on", manualAfterMs: null, source: "config" }), path: statePath, fs });
  const owner = { actor: "owner", now: 0 };
  createTask(db, owner, { project: P, id: "T1", title: "巡检", kind: "code", agent: "agent-task-t1", pm: "agent-claudestra", stage: "build" });
  moveStage(db, { actor: "owner", now: T0 - 30 * MIN }, { taskId: "T1", from: "build", to: "review" });
  setMeta(db, owner, { project: P, key: "pms", value: ["agent-claudestra", DIS] });
  baselineAudit(db, P);
});
afterEach(() => {
  setAuditEscalatePorts();
  closeLedger(path);
});

async function cli(...args: string[]): Promise<Record<string, any>> {
  const agents = ["agent-claudestra", DIS, "agent-task-t1"];
  return runLedger(["audit", ...args], {
    db, actor: "owner", actorProject: P, projectIds: [P], now: () => T0,
    auditSources: {
      registry: async () => agents.map((name) => ({ name, channelId: `c-${name}`, projectId: P, cwd: dir, sessionId: `s-${name}` })),
      windows: async () => ["master", ...agents], turn: async () => "idle",
      fileTimes: async () => ({ lastWriteAt: T0 - 5 * MIN, startedAt: 0 }), reviewers: () => [], heldPath: join(dir, "held.json"),
    },
    loadRegistry: async () => ({ agents: {} }) as unknown as Registry, saveRegistry: async () => {},
  }) as Promise<Record<string, any>>;
}

/** review_no_reviewer 推给调度助理（notifiedAt = T0），返回升级 id */
async function pushed(): Promise<string> {
  const f = (await cli("--json")).pending.find((x: any) => x.rule === "review_no_reviewer");
  expect(f.notify).toBe(DIS);
  expect(await cli("--ack", f.key)).toEqual({ ok: true, acked: 1 });
  return `${f.key}@${T0}`;
}
const nameOf = (id: string) => `sha256-${createHash("sha256").update(id).digest("hex")}`;
const marker = (id: string) => JSON.parse(readFileSync(join(markers, nameOf(id)), "utf8")) as unknown;
const state = () => JSON.parse(readFileSync(statePath, "utf8")) as Record<string, number>;
const escalated = () => auditEscalations(db, [P], T0 + 61 * MIN)!.map((x) => `${x.key}@${x.notifiedAt}`);
const errno = (code: string) => Object.assign(new Error(`${code}: operation not permitted`), { code });
function quiet<T>(fn: () => T): { out: T; logs: string[] } {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const out = fn();
    return { out, logs: spy.mock.calls.map((c) => c.map(String).join(" ")) };
  } finally {
    spy.mockRestore();
  }
}

describe("[验收线 1] 清理方与修复方交错：清理方不删别人刚修好的合法确认", () => {
  test("A（id 集 {a}）读到坏标记 x 之后、动最终名之前，B（id 集 {x}）修好 x；A 跑完 x 的合法确认仍在", async () => {
    const x = await pushed();
    const a = x.replace(`@${T0}`, `@${T0 + 1}`); // 另一组 id（已失效，A 自己清掉）
    mkdirSync(markers, { recursive: true });
    writeFileSync(join(markers, nameOf(x)), ""); // 掉电留下的坏标记
    let injected = false, bDone = -1;
    // 清理方对最终名 x 的第一个破坏性动作（旧：unlink；新：rename 到私有名）之前，B 同步跑完整个 --ack-escalate
    const gate = (op: "rename" | "unlink") => (p: string, ...rest: string[]) => {
      if (!injected && basename(p) === nameOf(x)) {
        injected = true;
        void ackEscalations(db, [x], T0 + 5, statePath).then((n) => { bDone = n; });
      }
      return op === "rename" ? realFs.rename(p, rest[0]!) : realFs.unlink(p);
    };
    hook = { rename: gate("rename"), unlink: gate("unlink") as EscalateFsPort["unlink"] };
    quiet(() => void ackEscalations(db, [a], T0 + 4, statePath));
    await Bun.sleep(0);
    expect(injected).toBe(true);
    expect(bDone).toBe(1);
    expect(existsSync(join(markers, nameOf(x)))).toBe(true);
    expect(marker(x)).toEqual({ id: x, at: T0 + 5 });
    expect(readdirSync(markers)).toEqual([nameOf(x)]); // 私有名不残留
    writeFileSync(statePath, "{}"); // 汇总里也没有这条：只剩标记做确认依据
    expect(escalated()).toEqual([]);
  });

  test("下一轮 compact 收掉私有名残留：合法的放回最终名，坏的删掉", async () => {
    const x = await pushed();
    mkdirSync(markers, { recursive: true });
    writeFileSync(join(markers, `.stale.${nameOf(x)}.p1`), JSON.stringify({ id: x, at: T0 + 7 })); // 清理方放回前掉电
    writeFileSync(join(markers, `.stale.${nameOf(`${x}9`)}.p2`), "");
    quiet(() => void ackEscalations(db, [], T0 + 8, statePath));
    expect(readdirSync(markers)).toEqual([nameOf(x)]);
    expect(marker(x)).toEqual({ id: x, at: T0 + 7 });
    expect(state()).toEqual({ [x]: T0 + 7 });
  });
});

describe("[验收线 2] 坏标记删不掉：compact 不中断", () => {
  test("清理坏标记时 unlink 抛 EPERM：不抛，汇总照常重建、失效条目照常清理，记一条诊断", async () => {
    const x = await pushed();
    const stale = x.replace(`@${T0}`, `@${T0 + 2}`);
    const bad = nameOf(x.replace(`@${T0}`, `@${T0 + 3}`));
    mkdirSync(markers, { recursive: true });
    writeFileSync(join(markers, nameOf(stale)), JSON.stringify({ id: stale, at: 1 }));
    writeFileSync(join(markers, bad), "");
    writeFileSync(statePath, JSON.stringify({ [stale]: 1, "old@5": 2 }));
    const isBad = (p: string) => basename(p) === bad || basename(p).startsWith(`.stale.${bad}.`);
    hook = { unlink: (p) => { if (isBad(p)) throw errno("EPERM"); realFs.unlink(p); } };
    const { out, logs } = quiet(() => ackEscalations(db, [x], T0 + 9, statePath));
    expect(await out).toBe(1);
    expect(state()).toEqual({ [x]: T0 + 9 });
    expect(existsSync(join(markers, nameOf(stale)))).toBe(false);
    expect(logs.filter((l) => l.includes("EPERM"))).toHaveLength(1);
  });
});

describe("[验收线 3] 最终名是目录", () => {
  test("修复失败的错误信息带错误码、不带完整路径；已确认的条目不重复推送", async () => {
    const x = await pushed();
    await ackEscalations(db, [x], T0 + 1, statePath);
    expect(escalated()).toEqual([]);
    const y = x.replace(`@${T0}`, `@${T0 + 4}`);
    mkdirSync(join(markers, nameOf(y)));
    let err: Error | null = null;
    try {
      quiet(() => void ackEscalations(db, [y, x], T0 + 2, statePath).catch((e) => { err = e; }));
      await Bun.sleep(0);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/E(ISDIR|PERM|NOTEMPTY|EXIST)/);
    expect(err!.message).not.toContain(dir);
    expect(escalated()).toEqual([]);
    expect(marker(x)).toEqual({ id: x, at: T0 + 1 });
  });
});
