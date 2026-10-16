import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AllowlistError, parseAllowlist } from "../src/lib/floka-compat/retirement/allowlist.js";
import { parseRetireGear } from "../src/lib/floka-compat/retirement/gear.js";
import { reasonsFor, RETIRE_ITEMS, type RetireItem } from "../src/lib/floka-compat/retirement/items.js";
import { RetireError, runRetirement, type RetireInput, type RetireIo } from "../src/lib/floka-compat/retirement/run.js";
import type { ItemPlan } from "../src/lib/floka-compat/retirement/plan.js";
import { AREAS, CENTER_AREAS, CLIENT_KINDS, INFRA_ITEMS, PAYLOAD_KINDS } from "../src/lib/floka-observation/types.js";
import { retireMain } from "../scripts/rename-floka/retirement/cli.ts";

const REPO = resolve(import.meta.dir, "..");
const ALLOWLIST_PATH = join(REPO, "scripts/rename-floka/codemod/compat-allowlist.json");
const ALLOWLIST = readFileSync(ALLOWLIST_PATH, "utf8");
const DAY = 86_400_000;
const NOW = Date.UTC(2027, 2, 1);
const CUT = NOW - 100 * DAY;
const OBSERVE = { rename: { retireCompat: "observe" } };
const ON = { rename: { retireCompat: "on" } };

/** 合成「全部证据齐全」的样本；各测试在它上面改一处，看只挡住对应的项 */
function evidence(): Record<string, any> {
  const cells: any[] = [];
  for (const direction of ["receive", "send"]) for (const area of AREAS) {
    for (const source of CENTER_AREAS.includes(area) ? ["machine", "center"] : ["machine"]) cells.push({ direction, area, source, legacy: 0, floka: 7 });
  }
  const node = (id: string, kind: string) => ({ id, kind, version: "3.1.0", receiveFloka: true, sendFamily: "floka" });
  return {
    v: 1, fleet: { machines: 3 }, allNewSendAt: CUT, rollbackPeriodMs: 14 * DAY, window: { start: CUT, end: NOW - 60_000 },
    nodes: [node("mac-1", "machine"), node("mac-2", "machine"), node("mac-3", "machine"), node("relay-a", "relay"), node("ledger-a", "ledger")],
    traffic: cells, sessions: { legacyMcp: 0 }, pending: { legacyCalls: 0, maxExpiresAt: null },
    clients: CLIENT_KINDS.map((kind) => ({ kind, legacy: 0, offline: 0 })),
    payloads: PAYLOAD_KINDS.map((kind) => ({ kind, legacyLive: 0, maxExpiresAt: CUT })),
    infra: Object.fromEntries(INFRA_ITEMS.map((k) => [k, "done"])),
  };
}

/** 一碰就抛：observe / off 路径上不许有任何文件系统调用 */
const untouchable: RetireIo = new Proxy({} as RetireIo, { get: (_t, k) => () => { throw new Error(`io.${String(k)} 被调用`); } });

function input(sample: Record<string, any> | null, over: Partial<RetireInput> = {}): RetireInput {
  return {
    config: OBSERVE, sampleText: sample && JSON.stringify(sample), allowlistText: ALLOWLIST, now: NOW, tmpRoots: [tmpdir()], io: untouchable, ...over,
  };
}

function plan(sample: Record<string, any>, allowlistText = ALLOWLIST) {
  const r = runRetirement(input(sample, { allowlistText }));
  if (r.gear === "off") throw new Error("unexpected off");
  return Object.fromEntries(r.plan.items.map((p) => [p.item, p])) as Record<RetireItem, ItemPlan>;
}
const retirable = (sample: Record<string, any>, allowlistText = ALLOWLIST) =>
  Object.values(plan(sample, allowlistText)).filter((p) => p.retirable).map((p) => p.item).sort();
const cell = (s: Record<string, any>, direction: string, area: string, source = "machine") =>
  s.traffic.find((t: any) => t.direction === direction && t.area === area && t.source === source);

/** 把阶段 1 的项预先标成已收，用来单独看阶段 2 的判定 */
function phase1Retired(): string {
  const o = JSON.parse(ALLOWLIST);
  const moving = o.entries.filter((e: any) => e.item === "legacy-send" || e.item === "install-alias");
  o.entries = o.entries.filter((e: any) => !moving.includes(e));
  o.retired = moving.map((e: any) => ({ ...e, retiredAt: CUT }));
  return JSON.stringify(o);
}

describe("[验收线 1] 旧客户端 / 旧会话 / 未过期邀请 / unknown / 未满回滚期都阻止退出，齐全证据只放行对应项", () => {
  test("证据齐全时阶段 1 两项可收；阶段 2 要等阶段 1 收完", () => {
    const p = plan(evidence());
    expect(retirable(evidence())).toEqual(["install-alias", "legacy-send"]);
    expect(p["receive-e2e"].reasons.map((r) => r.code)).toEqual(["phase_order", "phase_order"]);
    expect(retirable(evidence(), phase1Retired())).toEqual(RETIRE_ITEMS.filter((i) => i !== "legacy-send" && i !== "install-alias").sort());
  });

  test("阶段 1 有项被挡时阶段 2 记 phase_order", () => {
    const s = evidence();
    s.sessions.legacyMcp = 2;
    const p = plan(s);
    expect(p["install-alias"].retirable).toBe(false);
    expect(p["legacy-send"].retirable).toBe(true);
    expect(p["receive-e2e"].reasons).toEqual([{ code: "phase_order", subject: "legacy-send" }, { code: "phase_order", subject: "install-alias" }]);
  });

  test("旧客户端只挡浏览器相关项", () => {
    const s = evidence();
    s.clients.find((c: any) => c.kind === "browser").legacy = 1;
    expect(retirable(s, phase1Retired())).toEqual(["env", "receive-e2e", "receive-ledger", "receive-relay", "receive-signature"]);
  });

  test("旧 MCP 会话挡安装别名、env 与旧读", () => {
    const s = evidence();
    s.sessions.legacyMcp = 1;
    const out = retirable(s, phase1Retired());
    expect(out).not.toContain("env");
    expect(out).not.toContain("legacy-read");
    expect(out).toContain("scheme");
    expect(plan(s)["install-alias"].reasons).toEqual([{ code: "legacy_sessions" }]);
  });

  test("未过期邀请只挡签名接收与 scheme", () => {
    const s = evidence();
    s.payloads.find((p: any) => p.kind === "invite").maxExpiresAt = NOW + DAY;
    const p = plan(s, phase1Retired());
    expect(p["receive-signature"].reasons).toEqual([{ code: "payload_unexpired", subject: "invite" }]);
    expect(p.scheme.reasons).toEqual([{ code: "payload_unexpired", subject: "invite" }]);
    expect(p["receive-e2e"].retirable).toBe(true);
    expect(p["legacy-read"].retirable).toBe(false);
  });

  test("阶段 1 已收、其余证据齐全时：存着的邀请 / 邀请未知 / 浏览器接收旧流量或 unknown 各自挡 scheme", () => {
    const invite = (s: any) => s.payloads.find((p: any) => p.kind === "invite");
    for (const [mutate, reason] of [
      [(s: any) => { invite(s).maxExpiresAt = NOW + DAY; }, { code: "payload_unexpired", subject: "invite" }],
      [(s: any) => { invite(s).maxExpiresAt = "unknown"; }, { code: "payload_unexpired_unknown", subject: "invite" }],
      [(s: any) => { invite(s).legacyLive = 1; }, { code: "payload_live", subject: "invite" }],
      [(s: any) => { invite(s).legacyLive = "unknown"; }, { code: "payload_live_unknown", subject: "invite" }],
      [(s: any) => { cell(s, "receive", "browser").legacy = 3; }, { code: "legacy_traffic", subject: "receive/browser/machine" }],
      [(s: any) => { cell(s, "receive", "browser").legacy = "unknown"; }, { code: "legacy_traffic_unknown", subject: "receive/browser/machine" }],
      [(s: any) => { cell(s, "receive", "browser").floka = "unknown"; }, { code: "floka_traffic_unknown", subject: "receive/browser/machine" }],
    ] as const) {
      const s = evidence();
      mutate(s);
      const p = plan(s, phase1Retired());
      expect(p.scheme.retirable).toBe(false);
      expect(p.scheme.reasons).toContainEqual(reason);
      expect(p["receive-e2e"].retirable).toBe(true);
      expect(reasonsFor("scheme", [reason])).toEqual([reason]);
    }
  });

  test("unknown 与旧流量同样挡；外部安装副本未知挡别名 / env / scheme", () => {
    const s = evidence();
    cell(s, "send", "relay").floka = "unknown";
    s.infra.installCopies = "unknown";
    const p = plan(s);
    expect(p["legacy-send"].reasons).toEqual([{ code: "floka_traffic_unknown", subject: "send/relay/machine" }]);
    expect(p["install-alias"].reasons).toEqual([{ code: "infra_unknown", subject: "installCopies" }]);
    const p2 = plan(s, phase1Retired());
    expect(p2.env.retirable).toBe(false);
    expect(p2.scheme.retirable).toBe(false);
    expect(p2["receive-browser"].retirable).toBe(true);
  });

  test("回滚期未满、未全部切新、观察窗口不足挡所有项", () => {
    for (const mutate of [
      (s: any) => { s.rollbackPeriodMs = 200 * DAY; },
      (s: any) => { s.allNewSendAt = null; },
      (s: any) => { s.window = { start: NOW - 20 * DAY, end: NOW - 1 }; },
      (s: any) => { s.fleet.machines = "unknown"; },
    ]) {
      const s = evidence();
      mutate(s);
      expect(retirable(s)).toEqual([]);
      expect(retirable(s, phase1Retired())).toEqual([]);
    }
  });

  test("没人认领的新理由码挡全部项；旧读被任何理由挡", () => {
    const novel = [{ code: "brand_new_check", subject: "x" }];
    for (const item of RETIRE_ITEMS) expect(reasonsFor(item, novel)).toEqual(novel);
    expect(reasonsFor("legacy-read", [{ code: "legacy_clients", subject: "native" }])).toHaveLength(1);
    expect(reasonsFor("legacy-send", [{ code: "legacy_clients", subject: "native" }])).toEqual([]);
  });

  test("中心观察缺失只挡中继 / 台账接收", () => {
    const s = evidence();
    s.traffic = s.traffic.filter((t: any) => t.source !== "center");
    const p = plan(s, phase1Retired());
    expect(p["receive-relay"].reasons.map((r) => r.code)).toContain("center_observation_missing");
    expect(p["receive-ledger"].retirable).toBe(false);
    expect(p["receive-signature"].retirable).toBe(true);
  });
});

describe("[验收线 2] observe 零写入；on 临时执行保持身份 / 历史哈希不变", () => {
  test("rename.retireCompat 缺省与写错都是 off，off 不读样本", () => {
    expect(parseRetireGear({}).gear).toBe("off");
    expect(parseRetireGear({ rename: { retireCompat: "yes" } })).toEqual({ gear: "off", problems: [expect.stringContaining("按 off")] });
    expect(runRetirement(input(null, { config: {} }))).toEqual({ gear: "off", problems: [] });
  });

  test("observe 不调用任何 io，不改允许表；给 --target / --items 直接拒", () => {
    const r = runRetirement(input(evidence()));
    expect(r.gear).toBe("observe");
    expect(readFileSync(ALLOWLIST_PATH, "utf8")).toBe(ALLOWLIST);
    expect(() => runRetirement(input(evidence(), { target: tmpdir() }))).toThrow(RetireError);
    expect(() => runRetirement(input(evidence(), { items: ["legacy-send"] }))).toThrow(RetireError);
  });

  test("on 写进空临时目录；源允许表、状态目录里的身份与历史文件逐字节不变", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "floka-retire-")));
    try {
      const state = join(root, "state"), target = join(root, "out");
      mkdirSync(join(state, "transcripts"), { recursive: true });
      mkdirSync(target);
      const files: Record<string, string> = {
        "instance-key.json": "{\"k\":1}", "identity.json": "{}", "peers.json": "[]", "revocations.json": "[]",
        "transcripts/a.jsonl": "{\"name\":\"claudestra\"}\n", "config.json": "{}",
      };
      for (const [rel, body] of Object.entries(files)) writeFileSync(join(state, rel), body);
      const hash = () => Object.keys(files).map((rel) => createHash("sha256").update(readFileSync(join(state, rel))).digest("hex"));
      const before = hash();
      const sampleFile = join(root, "s.json"), configFile = join(root, "c.json");
      writeFileSync(sampleFile, JSON.stringify(evidence()));
      writeFileSync(configFile, JSON.stringify(ON));
      const { code, result } = await retireMain(
        ["--sample", sampleFile, "--config", configFile, "--items", "legacy-send", "--target", target, "--state", state], NOW);
      expect(code).toBe(0);
      if (!result || result.gear !== "on" || !result.executed) throw new Error("on 没执行");
      expect(result.executed.retired).toEqual(["legacy-send"]);
      expect(result.executed.protectedFiles).toBe(5);
      expect(hash()).toEqual(before);
      expect(readFileSync(ALLOWLIST_PATH, "utf8")).toBe(ALLOWLIST);
      expect(readdirSync(target).sort()).toEqual(["compat-allowlist.json", "compat-allowlist.recovery.json", "retirement-plan.json"]);
      expect(readFileSync(join(target, "compat-allowlist.recovery.json"), "utf8")).toBe(ALLOWLIST);
      const next = parseAllowlist(readFileSync(join(target, "compat-allowlist.json"), "utf8"));
      const orig = parseAllowlist(ALLOWLIST);
      expect(next.retain).toEqual(orig.retain);
      expect(next.retired.map((e) => e.id)).toEqual(orig.entries.filter((e) => e.item === "legacy-send").map((e) => e.id));
      expect(next.entries).toEqual(orig.entries.filter((e) => e.item !== "legacy-send"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("on 的目标必须在临时目录下、为空、不与状态目录重叠", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "floka-retire-")));
    try {
      const state = join(root, "state");
      mkdirSync(state);
      writeFileSync(join(state, "peers.json"), "[]");
      const io: RetireIo = {
        realpath: (p) => realpathSync(p), isDir: () => true, readBytes: (p) => readFileSync(p),
        listFiles: (d) => readdirSync(d).map((n) => join(d, n)),
        writeNew: () => { throw new Error("不该写"); },
      };
      const on = (target: string) => runRetirement(input(evidence(), { config: ON, items: ["legacy-send"], target, stateDir: state, io }));
      expect(() => on(state)).toThrow("重叠");
      expect(() => on(REPO)).toThrow("临时目录");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("[验收线 3] 一项失败不越权收其他兼容；退出计划与恢复路径可审查", () => {
  const onIo = (written: string[]): RetireIo => ({
    realpath: (p) => p, isDir: () => true, listFiles: () => [], readBytes: () => new Uint8Array(), writeNew: (p) => { written.push(p); },
  });
  const on = (items: string[], sample = evidence(), allowlistText = ALLOWLIST, written: string[] = []) => runRetirement(input(sample, {
    config: ON, items, target: join(tmpdir(), "floka-retire-target"), stateDir: "/state-for-test", allowlistText, io: onIo(written),
  }));

  test("点名项里有一项被挡：整次拒绝、一个文件都不写", () => {
    const s = evidence();
    s.sessions.legacyMcp = 1;
    const written: string[] = [];
    expect(() => on(["legacy-send", "install-alias"], s, ALLOWLIST, written)).toThrow(/拒绝执行.*install-alias\(legacy_sessions\)/);
    expect(written).toEqual([]);
  });

  test("没点名的项即使可收也不动", () => {
    const r = on(["install-alias"]);
    if (r.gear !== "on" || !r.executed) throw new Error("on 没执行");
    expect(r.executed.retired).toEqual(["install-alias"]);
    expect(r.plan.items.find((p) => p.item === "legacy-send")?.retirable).toBe(true);
  });

  test("阶段 2 不能越过未收的阶段 1；同次点名一起收可以", () => {
    expect(() => on(["receive-e2e"])).toThrow("receive-e2e(phase_order:legacy-send,phase_order:install-alias)");
    const r = on(["legacy-send", "install-alias", "receive-e2e"]);
    if (r.gear !== "on" || !r.executed) throw new Error("on 没执行");
    expect(r.executed.retired).toEqual(["legacy-send", "install-alias", "receive-e2e"]);
  });

  test("阶段 1 已收时，存着的有效邀请或浏览器接收 unknown 让 on 拒收 scheme，一个文件都不写", () => {
    for (const mutate of [
      (s: any) => { s.payloads.find((p: any) => p.kind === "invite").maxExpiresAt = NOW + DAY; },
      (s: any) => { cell(s, "receive", "browser").legacy = "unknown"; },
    ]) {
      const s = evidence();
      mutate(s);
      const written: string[] = [];
      expect(() => on(["scheme"], s, phase1Retired(), written)).toThrow(/拒绝执行.*scheme\(/);
      expect(written).toEqual([]);
    }
    const r = on(["scheme"], evidence(), phase1Retired());
    if (r.gear !== "on" || !r.executed) throw new Error("on 没执行");
    expect(r.executed.retired).toEqual(["scheme"]);
  });

  test("on 不点名、点名未知项、点名已收的项都拒", () => {
    expect(() => on([])).toThrow("逐项点名");
    expect(() => on(["everything"])).toThrow("不认识");
    expect(() => on(["legacy-send"], evidence(), phase1Retired())).toThrow("legacy-send(retired)");
  });

  test("计划每项带恢复说明与条目；超出删除预算时提示另拆", () => {
    const p = plan(evidence());
    expect(p["legacy-send"].entries).toEqual(["send.peer-signature", "send.relay-canonical"]);
    expect(p["legacy-send"].restore).toContain("compat-allowlist.recovery.json");
    const o = JSON.parse(ALLOWLIST);
    for (let i = 0; i < 12; i++) o.entries.push({ ...o.entries[0], id: `send.extra-${i}` });
    const r = runRetirement(input(evidence(), { allowlistText: JSON.stringify(o) }));
    if (r.gear === "off") throw new Error("unexpected off");
    expect(r.plan.budget).toEqual({ retirableEntries: 17, limit: 12, splitRequired: true });
  });
});

describe("compat-allowlist.json", () => {
  test("仓库里的表能解析，每条的 match 在它列的每个文件里都命中", () => {
    const list = parseAllowlist(ALLOWLIST);
    expect(new Set(list.entries.map((e) => e.item))).toEqual(new Set(RETIRE_ITEMS));
    for (const e of list.entries) for (const f of e.files) {
      expect({ id: e.id, f, hit: new RegExp(e.match).test(readFileSync(join(REPO, f), "utf8")) }).toEqual({ id: e.id, f, hit: true });
    }
  });

  test("可退出条目指到受保护文件、通配路径、重复 id、空保护名单都整张作废", () => {
    const mutate = (fn: (o: any) => void) => { const o = JSON.parse(ALLOWLIST); fn(o); return JSON.stringify(o); };
    expect(() => parseAllowlist(mutate((o) => { o.entries[0].files = ["src/lib/peers.json"]; }))).toThrow("retain.identity");
    expect(() => parseAllowlist(mutate((o) => { o.entries[0].files = ["data/transcripts/x.md"]; }))).toThrow("retain.history");
    expect(() => parseAllowlist(mutate((o) => { o.entries[0].files = ["src/**"]; }))).toThrow(AllowlistError);
    expect(() => parseAllowlist(mutate((o) => { o.entries[0].files = ["../outside.ts"]; }))).toThrow(AllowlistError);
    expect(() => parseAllowlist(mutate((o) => { o.entries[1].id = o.entries[0].id; }))).toThrow("重复");
    expect(() => parseAllowlist(mutate((o) => { o.retain = []; }))).toThrow("保护名单");
    expect(() => parseAllowlist(mutate((o) => { o.entries[0].item = "all"; }))).toThrow("退出项");
  });
});
