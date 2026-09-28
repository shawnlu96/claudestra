/**
 * `ledger verify`（src/manager/ledger-verify.ts）+ 事实采集（src/lib/ledger-verify-facts.ts）+ recordVerify：
 * 外部命令全换成假的（gh / git / lsof / launchctl / ps），核对：全过同事务推 verified、没过只记事件不推、豁免、dry-run 不写库、
 * 角色、stage 直推 verified 被堵、采集只跑检查单要的命令。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeLedger, getTask, listEvents, LedgerError, openLedger } from "../src/lib/ledger-store.js";
import type { FactsDeps } from "../src/lib/ledger-verify-facts.js";
import { createTask, moveStage, recordVerify, setMeta } from "../src/lib/ledger-write.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const PM = "agent-claudestra";
const EXE = "agent-task-t8g";
const MERGED = "2026-09-28T12:00:00Z";
const LATER = "Wed Sep 30 08:00:00 2026"; // ps lstart 是本地时区；测试机时区不定，前后各隔开一天以上
const EARLIER = "Sun Sep 27 08:00:00 2026";

let db: Database;
let calls: string[];
let sc: {
  files: string[];
  state: string;
  ghFails: boolean;
  headInMain: boolean;
  localWeb: string | null;
  relay: { enabled: boolean; base?: string } | null;
  relayWeb: string | null;
  bridgeStart: string;
  sizes: Record<string, number>;
};

function out(code: number, stdout = "", stderr = "") {
  return Promise.resolve({ code, stdout, stderr });
}

/** 假的外部命令：期望的网页提交 w1；w2 是 w1 的后代；old 是更早的版本 */
const fakeDeps = (): FactsDeps => ({
  repoRoot: "/repo",
  run: (argv) => {
    const cmd = argv.filter((a) => a !== "-C" && a !== "/repo").join(" ");
    calls.push(cmd);
    if (cmd.startsWith("gh pr view")) {
      if (sc.ghFails) return out(1, "", "gh: not logged in\n");
      return out(0, JSON.stringify({ state: sc.state, mergeCommit: { oid: "m1" }, mergedAt: MERGED, headRefOid: "h1", files: sc.files.map((path) => ({ path })) }));
    }
    if (cmd === "git fetch --quiet origin main") return out(0);
    if (cmd === "git merge-base --is-ancestor h1 origin/main") return out(sc.headInMain ? 0 : 1);
    if (cmd.startsWith("git log -1 --format=%H m1 -- web")) return out(0, "w1\n");
    if (cmd.startsWith("git cat-file -e")) return out(["w1^{commit}", "w2^{commit}", "old^{commit}"].includes(argv.at(-1)!) ? 0 : 128);
    if (cmd.startsWith("git merge-base --is-ancestor w1 ")) return out(["w1", "w2"].includes(argv.at(-1)!) ? 0 : 1);
    if (cmd.startsWith("lsof")) return out(0, "4242\n");
    if (cmd === "launchctl list") return out(0, "PID\tStatus\tLabel\n555\t0\tcom.claudestra.cron\n");
    if (cmd === "ps -o lstart= -p 4242") return out(0, `${sc.bridgeStart}\n`);
    if (cmd === "ps -o lstart= -p 555") return out(0, `${LATER}\n`);
    return out(127, "", `unexpected ${cmd}`);
  },
  localWebCommit: () => sc.localWeb,
  relayStatus: async () => sc.relay,
  relayWebCommit: async () => sc.relayWeb,
  bridgePort: () => 3847,
  fileSize: (p) => sc.sizes[p] ?? null,
});

async function run(actor: string, ...args: string[]) {
  const reg: Registry = { socket: "", agents: { [PM]: { status: "active", projectId: P }, [EXE]: { status: "active", projectId: P } } as unknown as Registry["agents"] };
  return runLedger(args, {
    db, actor, actorProject: P, projectIds: [P],
    loadRegistry: async () => reg, saveRegistry: async () => {}, now: () => 5_000, factsDeps: fakeDeps,
  }) as Promise<Record<string, any>>;
}

function liveTask(id = "T9", pr: string | null = "https://github.com/x/y/pull/150", extra: Record<string, unknown> = {}) {
  createTask(db, { actor: "owner" }, { project: P, id, title: "t", kind: "code", agent: EXE, pm: PM, pr, stage: "live", round: 1, extra });
}

beforeEach(() => {
  calls = [];
  sc = { files: ["web/a.tsx", "src/bridge/x.ts"], state: "MERGED", ghFails: false, headInMain: true, localWeb: "w1",
    relay: { enabled: true, base: "relay.example" }, relayWeb: "w2", bridgeStart: LATER, sizes: {} };
  db = openLedger(":memory:");
  setMeta(db, { actor: "owner" }, { project: P, key: "pms", value: [PM] });
  liveTask();
});
afterEach(() => closeLedger(":memory:"));

const stages = (id = "T9") => listEvents(db, { project: P, target: id }).filter((e) => e.kind === "stage").map((e) => `${e.data.from}>${e.data.to}`);

describe("ledger verify", () => {
  test("全过：记 verify 事件（带每项证据）并同事务推 live → verified", async () => {
    const r = await run(PM, "verify", "T9");
    expect(r).toMatchObject({ ok: true, moved: true, result: "pass", task: { stage: "verified" } });
    expect(r.checks.map((c: any) => [c.id, c.status])).toEqual([["pr-merged", "pass"], ["web-local", "pass"], ["web-relay", "pass"], ["daemon-bridge", "pass"]]);
    expect(r.event).toMatchObject({ kind: "verify", actor: PM, data: { result: "pass", checklistSource: "files", incomplete: false } });
    expect(stages()).toEqual(["live>verified"]);
  });
  test("有一项没过：只记事件、留在 live、退出码语义 ok:false，报错里写明哪一项", async () => {
    sc.bridgeStart = EARLIER;
    const r = await run(PM, "verify", "T9");
    expect(r).toMatchObject({ ok: false, code: "unverified", moved: false, result: "fail", task: { stage: "live" } });
    expect(r.error).toContain("daemon-bridge（fail）");
    expect(r.error).toContain("还没重启");
    expect(listEvents(db, { project: P, target: "T9" }).filter((e) => e.kind === "verify").map((e) => e.data.result)).toEqual(["fail"]);
    expect(stages()).toEqual([]);
  });
  test("中继没更新 → fail；中继查不到 → unknown，PM 带理由豁免后推进，事件里记着豁免", async () => {
    sc.relayWeb = "old";
    expect(await run(PM, "verify", "T9")).toMatchObject({ ok: false, result: "fail", blocking: expect.stringContaining("web-relay") });
    sc.relayWeb = null;
    expect(await run(PM, "verify", "T9")).toMatchObject({ ok: false, result: "unknown" });
    expect(await run(PM, "verify", "T9", "--waive", "web-relay")).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("--text") });
    const r = await run(PM, "verify", "T9", "--waive", "web-relay", "--text", "中继维护中");
    expect(r).toMatchObject({ ok: true, moved: true, result: "pass" });
    expect(r.event.data.checks.find((c: any) => c.id === "web-relay")).toMatchObject({ status: "unknown", waived: "中继维护中" });
  });
  test("豁免写错探针 id / 豁免不在单里的项 → invalid", async () => {
    expect(await run(PM, "verify", "T9", "--waive", "nope", "--text", "x")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run(PM, "verify", "T9", "--waive", "daemon-cron", "--text", "x")).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("不在这次的检查单里") });
  });
  test("--dry-run：执行者也能跑，不写库；正式跑只有 PM / master / owner", async () => {
    sc.localWeb = "old";
    const before = listEvents(db, { project: P, target: "T9" }).length;
    expect(await run(EXE, "verify", "T9", "--dry-run")).toMatchObject({ ok: true, dryRun: true, result: "fail" });
    expect(listEvents(db, { project: P, target: "T9" }).length).toBe(before);
    expect(await run(EXE, "verify", "T9")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run("agent-stranger", "verify", "T9", "--dry-run")).toMatchObject({ ok: false, code: "forbidden" });
  });
  test("不在 live 不能正式跑（提示用 --dry-run）", async () => {
    createTask(db, { actor: "owner" }, { project: P, id: "T10", title: "t", kind: "code", agent: EXE, pr: "#1", stage: "merge", round: 1 });
    expect(await run(PM, "verify", "T10")).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("--dry-run") });
  });
  test("没挂 PR：只要证据文件，非空才过；不跑 gh / git", async () => {
    liveTask("T11", null);
    expect(await run(PM, "verify", "T11")).toMatchObject({ ok: false, result: "fail", blocking: expect.stringContaining("--evidence") });
    sc.sizes["docs/T11.report.md"] = 0;
    expect(await run(PM, "verify", "T11", "--evidence", "docs/T11.report.md")).toMatchObject({ ok: false, result: "fail" });
    sc.sizes["docs/T11.report.md"] = 800;
    expect(await run(PM, "verify", "T11", "--evidence", "docs/T11.report.md")).toMatchObject({ ok: true, moved: true });
    expect(calls).toEqual([]);
  });
  test("gh 失败又没手工指定 → unknown，豁免也救不了", async () => {
    sc.ghFails = true;
    const r = await run(PM, "verify", "T9", "--waive", "pr-merged", "--text", "gh 坏了");
    expect(r).toMatchObject({ ok: false, result: "unknown", blocking: expect.stringContaining("推断不出检查单") });
    expect(getTask(db, "T9")?.stage).toBe("live");
  });
  test("extra.checks 替换推断；只采单子里要的（没有 web 探针就不问中继、不读版本）", async () => {
    liveTask("T12", "#12", { checks: ["cron"] });
    let relayAsked = false;
    const r = await runLedger(["verify", "T12"], {
      db, actor: PM, actorProject: P, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => 1,
      factsDeps: () => ({ ...fakeDeps(), relayStatus: async () => ((relayAsked = true), null) }),
    }) as Record<string, any>;
    expect(r).toMatchObject({ ok: true, checklistSource: "extra" });
    expect(r.checks.map((c: any) => c.id)).toEqual(["pr-merged", "daemon-cron"]);
    expect(relayAsked).toBe(false);
    expect(calls.some((c) => c.startsWith("lsof"))).toBe(false);
    liveTask("T13", "#13", { checks: ["webb"] });
    expect(await run(PM, "verify", "T13")).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("extra.checks") });
  });
  test("没配中继 → web-relay 不适用算过；本机网页是后代版本也算过", async () => {
    sc.relay = { enabled: false };
    sc.localWeb = "w2";
    expect(await run(PM, "verify", "T9")).toMatchObject({ ok: true, moved: true });
  });
  test("dedup 重放：结论以当时记下的为准", async () => {
    sc.bridgeStart = EARLIER;
    expect(await run(PM, "verify", "T9", "--dedup", "v1")).toMatchObject({ ok: false });
    sc.bridgeStart = LATER;
    expect(await run(PM, "verify", "T9", "--dedup", "v1")).toMatchObject({ ok: false, duplicate: true });
  });
});

describe("进 verified 只有一条路", () => {
  test("stage 直推 verified 被拒并提示改用 ledger verify；从 blocked 回到 verified 不受影响", async () => {
    const r = await run(PM, "stage", "T9", "--from", "live", "--to", "verified");
    expect(r).toMatchObject({ ok: false, code: "forbidden", error: expect.stringContaining("ledger verify") });
    recordVerify(db, { actor: PM }, { taskId: "T9", result: "pass", data: {} });
    moveStage(db, { actor: PM }, { taskId: "T9", from: "verified", to: "blocked" });
    expect(moveStage(db, { actor: PM }, { taskId: "T9", from: "blocked", to: "verified" }).row.stage).toBe("verified");
  });
  test("recordVerify：执行者不能记；任务已不在 live → conflict", () => {
    const err = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as LedgerError).code;
      }
      return null;
    };
    expect(err(() => recordVerify(db, { actor: EXE }, { taskId: "T9", result: "pass", data: {} }))).toBe("forbidden");
    moveStage(db, { actor: PM }, { taskId: "T9", from: "live", to: "fix" });
    expect(err(() => recordVerify(db, { actor: PM }, { taskId: "T9", result: "pass", data: {} }))).toBe("conflict");
  });
});
