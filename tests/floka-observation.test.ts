import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseObservationGear } from "../src/lib/floka-observation/gear.js";
import { MIN_OBSERVE_MS, PAYLOAD_LIFETIMES, requiredWindowMs } from "../src/lib/floka-observation/lifetimes.js";
import { buildReport } from "../src/lib/floka-observation/report.js";
import { runObservation, type ObservationIo } from "../src/lib/floka-observation/run.js";
import { parseSample, SampleError } from "../src/lib/floka-observation/sample.js";
import { AREAS, CENTER_AREAS, CLIENT_KINDS, DIRECTIONS, INFRA_ITEMS, PAYLOAD_KINDS } from "../src/lib/floka-observation/types.js";
import { observeMain } from "../scripts/rename-floka/observe.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2027, 0, 1);
const SWITCH = NOW - 120 * DAY;

/** 一份「完整零旧流量窗口」的合成样本：三机 + relay + ledger 全认全发新族，所有格子实测 0，存量全过期 */
function passing(): Record<string, any> {
  const traffic = DIRECTIONS.flatMap((direction) => AREAS.flatMap((area) =>
    (CENTER_AREAS.includes(area) ? ["machine", "center"] : ["machine"]).map((source) => ({ direction, area, source, legacy: 0, floka: 42 }))));
  return {
    v: 1, fleet: { machines: 3 }, window: { start: SWITCH, end: NOW - 3_600_000 }, allNewSendAt: SWITCH, rollbackPeriodMs: 30 * DAY,
    nodes: [
      ...["m-a", "m-b", "m-c"].map((id) => ({ id, kind: "machine", version: "3.0.0", receiveFloka: true, sendFamily: "floka" })),
      { id: "relay-1", kind: "relay", version: "3.0.0", receiveFloka: true, sendFamily: "floka" },
      { id: "ledger-1", kind: "ledger", version: "abc1234", receiveFloka: true, sendFamily: "floka" },
    ],
    traffic, sessions: { legacyMcp: 0 },
    clients: CLIENT_KINDS.map((kind) => ({ kind, legacy: 0, offline: 0 })),
    pending: { legacyCalls: 0, maxExpiresAt: null },
    payloads: PAYLOAD_KINDS.map((kind) => ({ kind, legacyLive: 0, maxExpiresAt: SWITCH + DAY })),
    infra: Object.fromEntries(INFRA_ITEMS.map((k) => [k, "done"])),
  };
}

const judge = (s: Record<string, any>, now = NOW) => buildReport(parseSample(JSON.stringify(s)), "observe", now).exit;
const codes = (s: Record<string, any>, now = NOW) => judge(s, now).reasons.map((r) => r.subject ? `${r.code}:${r.subject}` : r.code);

describe("[验收线 1] 旧流量 / unknown / 离线客户端 / 未过期载荷都拒绝退出，只有完整零旧流量窗口通过", () => {
  test("完整零旧流量窗口通过", () => {
    expect(judge(passing())).toEqual({ ok: true, reasons: [] });
  });

  test("任一格有旧流量就拒", () => {
    const s = passing();
    s.traffic.find((t: any) => t.direction === "send" && t.area === "e2e").legacy = 1;
    expect(codes(s)).toEqual(["legacy_traffic:send/e2e/machine"]);
  });

  test("没观测到的格子是 unknown，不按 0 算", () => {
    const s = passing();
    s.traffic = s.traffic.filter((t: any) => !(t.direction === "receive" && t.area === "browser"));
    s.traffic.find((t: any) => t.area === "signature" && t.direction === "send").legacy = "unknown";
    expect(codes(s)).toEqual(["legacy_traffic_unknown:receive/browser/machine", "legacy_traffic_unknown:send/signature/machine"]);
    const report = buildReport(parseSample(JSON.stringify(s)), "observe", NOW);
    expect(report.families.receive.browser.machine).toEqual({ legacy: "unknown", floka: "unknown" });
  });

  test("离线客户端、旧会话、缺报的客户端类别都拒", () => {
    const s = passing();
    s.clients = s.clients.filter((c: any) => c.kind !== "native");
    s.clients.find((c: any) => c.kind === "sw").offline = 2;
    s.sessions.legacyMcp = "unknown";
    expect(codes(s)).toEqual([
      "legacy_sessions_unknown", "offline_clients:sw", "legacy_clients_unknown:native", "offline_clients_unknown:native",
    ]);
  });

  test("未过期载荷、存活数未知、待处理调用未过期都拒", () => {
    const s = passing();
    s.payloads.find((p: any) => p.kind === "invite").maxExpiresAt = NOW + 60_000;
    s.payloads.find((p: any) => p.kind === "review-ticket").legacyLive = "unknown";
    s.payloads = s.payloads.filter((p: any) => p.kind !== "lend-receipt");
    s.pending = { legacyCalls: 0, maxExpiresAt: NOW + 1 };
    expect(codes(s)).toEqual([
      "pending_unexpired", "payload_unexpired:invite", "payload_live_unknown:review-ticket",
      "payload_live_unknown:lend-receipt", "payload_unexpired_unknown:lend-receipt",
    ]);
  });

  test("空样本：一切 unknown，绝不通过", () => {
    const exit = judge({ v: 1 });
    expect(exit.ok).toBe(false);
    expect(exit.reasons.length).toBeGreaterThan(20);
    expect(exit.reasons.some((r) => r.code === "center_observation_missing")).toBe(true);
  });

  test("窗口必须在全部切新之后、且不短于要求长度", () => {
    const early = passing();
    early.window.start = SWITCH - DAY;
    expect(codes(early)).toEqual(["window_before_switch"]);
    const short = passing();
    short.window.start = short.window.end - MIN_OBSERVE_MS;
    expect(codes(short)).toEqual(["window_too_short"]);
    const future = passing();
    future.window.end = NOW + DAY;
    expect(codes(future)).toEqual(["window_in_future"]);
  });
});

describe("[验收线 2] 支持新族但没全部切新发送不算完成", () => {
  test("三机、relay、台账都认新族，但一台仍发旧族", () => {
    const s = passing();
    s.nodes.find((n: any) => n.id === "m-b").sendFamily = "legacy";
    s.allNewSendAt = null;
    expect(codes(s)).toEqual(["node_send_not_new:m-b", "not_all_send_new"]);
  });

  test("relay / 台账只认不发、版本未知都拒", () => {
    const s = passing();
    s.nodes.find((n: any) => n.kind === "relay").sendFamily = "unknown";
    s.nodes.find((n: any) => n.kind === "ledger").receiveFloka = false;
    s.nodes.find((n: any) => n.id === "m-a").version = "unknown";
    expect(codes(s)).toEqual(["node_version_unknown:m-a", "node_send_unknown:relay-1", "node_receive_not_new:ledger-1"]);
  });

  test("缺一台机器、缺 relay 或台账节点就是不完整", () => {
    const s = passing();
    s.nodes = s.nodes.filter((n: any) => n.id !== "m-c" && n.kind !== "ledger");
    expect(codes(s)).toEqual(["fleet_incomplete:machine", "fleet_incomplete:ledger"]);
    const unknown = passing();
    delete unknown.fleet;
    expect(codes(unknown)).toEqual(["fleet_unknown"]);
  });

  test("中心没上报任何一格：列阻塞，不当零流量", () => {
    const s = passing();
    s.traffic = s.traffic.filter((t: any) => t.source !== "center");
    const report = buildReport(parseSample(JSON.stringify(s)), "observe", NOW);
    expect(report.blockers).toEqual(["center_observation_missing"]);
    expect(report.exit.ok).toBe(false);
    expect(report.families.send.relay.center.legacy).toBe("unknown");
  });

  test("基础设施未完成或未知单独列出并拒绝退出", () => {
    const s = passing();
    s.infra.vapid = "pending";
    delete s.infra.installCopies;
    expect(codes(s)).toEqual(["infra_pending:vapid", "infra_unknown:installCopies"]);
  });
});

describe("r1 复现：审查 P1", () => {
  test("复现 fleet-self-declared-shrink：样本自报 1 台机器不能把三机验收缩成一机", () => {
    const s = passing();
    s.fleet.machines = 1;
    s.nodes = s.nodes.filter((n: any) => n.id !== "m-b" && n.id !== "m-c");
    expect(judge(s).ok).toBe(false);
    expect(codes(s)).toEqual(["fleet_below_minimum", "fleet_incomplete:machine"]);
  });

  test("复现 unknown-new-family-count-accepted：新族计数 unknown 或缺字段都拒，实测 0 放行", () => {
    const s = passing();
    s.traffic[0].floka = "unknown";
    delete s.traffic[1].floka;
    expect(judge(s).ok).toBe(false);
    expect(codes(s)).toEqual(["floka_traffic_unknown:receive/signature/machine", "floka_traffic_unknown:receive/relay/machine"]);
    const zero = passing();
    zero.traffic[0].floka = 0;
    expect(judge(zero)).toEqual({ ok: true, reasons: [] });
  });
});

describe("[验收线 3] 报告脱敏、observe 零写入、回滚窗口未满拒绝退出", () => {
  test("回滚期未满拒；回滚期未知也拒", () => {
    const s = passing();
    s.rollbackPeriodMs = 200 * DAY;
    expect(codes(s)).toEqual(["rollback_open"]);
    delete s.rollbackPeriodMs;
    expect(codes(s)).toEqual(["rollback_unknown"]);
  });

  test("样本带凭据形状、格式外字段、域名式 id 整份拒，且不回显", () => {
    const leaks = [
      { ...passing(), nodes: [{ id: "m-a", kind: "machine", version: "tok_abcdef123456" }] },
      { ...passing(), note: "cstra_dev=xyz" },
      { ...passing(), sig: "A".repeat(64) },
    ];
    for (const s of leaks) {
      let err: unknown;
      try { parseSample(JSON.stringify(s)); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(SampleError);
      expect(String(err)).not.toMatch(/tok_|cstra_dev|AAAA/);
    }
    expect(() => parseSample(JSON.stringify({ ...passing(), token: "x" }))).toThrow("样本格式外的字段");
    expect(() => parseSample(JSON.stringify({ v: 1, nodes: [{ id: "relay.floka.ai", kind: "relay" }] }))).toThrow("只许 [a-z0-9-]");
    expect(() => parseSample(JSON.stringify({ v: 1, nodes: [{ id: "m-a", kind: "machine", version: "10.0.0.1:443" }] }))).toThrow("版本号");
  });

  test("同一格子报两遍整份拒", () => {
    const s = passing();
    s.clients.push({ kind: "browser", legacy: 0, offline: 0 });
    expect(() => parseSample(JSON.stringify(s))).toThrow("重复的格子");
  });

  test("报告只含数值、枚举和受限 id", () => {
    const text = JSON.stringify(buildReport(parseSample(JSON.stringify(passing())), "observe", NOW));
    const strings = [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    expect(strings.every((x) => /^[A-Za-z0-9./-]{0,40}$/.test(x))).toBe(true);
  });

  const throwingIo: ObservationIo = {
    realpath: () => { throw new Error("io touched"); },
    isDir: () => { throw new Error("io touched"); },
    writeNew: () => { throw new Error("io touched"); },
  };

  test("observe（缺省）与 off 不碰 io", () => {
    const text = JSON.stringify(passing());
    const base = { sampleText: text, now: NOW, tmpRoots: [tmpdir()], io: throwingIo };
    const r = runObservation({ ...base, config: {} });
    expect(r.gear).toBe("observe");
    expect(r.gear !== "off" && r.report.exit.ok).toBe(true);
    expect(runObservation({ ...base, config: { rename: { observation: "off" } } })).toEqual({ gear: "off", problems: [] });
    expect(() => runObservation({ ...base, config: {}, outDir: tmpdir() })).toThrow("observe 档零写入");
  });

  test("on 只写显式临时目录，不覆盖，不写临时根外", () => {
    const root = mkdtempSync(join(tmpdir(), "floka-obs-"));
    try {
      const io: ObservationIo = {
        realpath: (p) => realpathSync(p), isDir: (p) => statSync(p).isDirectory(),
        writeNew: (p, t) => writeFileSync(p, t, { flag: "wx" }),
      };
      const base = { sampleText: JSON.stringify(passing()), now: NOW, config: { rename: { observation: "on" } }, io };
      expect(() => runObservation({ ...base, tmpRoots: [tmpdir()] })).toThrow("--out");
      expect(() => runObservation({ ...base, tmpRoots: [tmpdir()], outDir: tmpdir() })).toThrow("临时目录下的子目录");
      expect(() => runObservation({ ...base, tmpRoots: [join(root, "elsewhere")], outDir: root })).toThrow("临时目录下的子目录");
      expect(() => runObservation({ ...base, tmpRoots: [tmpdir()], outDir: join(root, "missing") })).toThrow("不存在");
      const r = runObservation({ ...base, tmpRoots: [tmpdir()], outDir: root });
      expect(r.gear === "on" && r.written).toBeTruthy();
      expect(readdirSync(root)).toEqual([`floka-observation-${NOW}.json`]);
      expect(() => runObservation({ ...base, tmpRoots: [tmpdir()], outDir: root })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("脚本 observe 档：只打 stdout，不落任何文件；退出码区分通过与拒绝", async () => {
    const root = mkdtempSync(join(tmpdir(), "floka-obs-cli-"));
    try {
      const cfg = join(root, "config.json"), ok = join(root, "ok.json"), bad = join(root, "bad.json");
      writeFileSync(cfg, JSON.stringify({ rename: {} }));
      writeFileSync(ok, JSON.stringify(passing()));
      const failing = passing();
      failing.sessions.legacyMcp = 1;
      writeFileSync(bad, JSON.stringify(failing));
      const before = readdirSync(root).sort();
      const pass = await observeMain(["--sample", ok, "--config", cfg], NOW);
      expect(pass.code).toBe(0);
      const refused = await observeMain(["--sample", bad, "--config", cfg], NOW);
      expect(refused.code).toBe(1);
      expect(refused.result?.gear !== "off" && refused.result?.report.exit.reasons).toEqual([{ code: "legacy_sessions" }]);
      expect((await observeMain(["--config", cfg], NOW)).code).toBe(2);
      expect((await observeMain(["--sample", ok, "--config", cfg, "--out", root], NOW)).error).toContain("observe 档零写入");
      expect(readdirSync(root).sort()).toEqual(before);
      expect(readFileSync(cfg, "utf8")).toBe(JSON.stringify({ rename: {} }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("档位与有效期", () => {
  test("rename.observation 缺省 observe，写错按 observe 且不回显原值", () => {
    expect(parseObservationGear(undefined).gear).toBe("observe");
    expect(parseObservationGear({ rename: { observation: "on" } }).gear).toBe("on");
    const bad = parseObservationGear({ rename: { observation: "onn-secret" } });
    expect(bad.gear).toBe("observe");
    expect(bad.problems.join("")).not.toContain("onn-secret");
  });

  test("观察窗口至少 14 天，并覆盖最长已知有效期（邀请 24h、能力 7 天、设备凭据 90 天）", () => {
    expect(PAYLOAD_LIFETIMES.invite).toBe(DAY);
    expect(requiredWindowMs()).toBeGreaterThanOrEqual(MIN_OBSERVE_MS);
    for (const v of Object.values(PAYLOAD_LIFETIMES)) if (typeof v === "number") expect(requiredWindowMs()).toBeGreaterThanOrEqual(v);
    expect(PAYLOAD_LIFETIMES["review-ticket"]).toBe("unknown");
  });
});

// 临时根下嵌套目录：确保 on 档只认严格子目录（root 本身不算）
test("on 档接受临时根下的嵌套子目录", () => {
  const root = mkdtempSync(join(tmpdir(), "floka-obs-nest-"));
  try {
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    const io: ObservationIo = { realpath: realpathSync, isDir: (p) => statSync(p).isDirectory(), writeNew: (p, t) => writeFileSync(p, t, { flag: "wx" }) };
    const r = runObservation({ sampleText: JSON.stringify({ v: 1 }), now: NOW, config: { rename: { observation: "on" } }, outDir: nested, tmpRoots: [tmpdir()], io });
    expect(r.gear === "on" && r.report.exit.ok).toBe(false);
    expect(readdirSync(nested).length).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
