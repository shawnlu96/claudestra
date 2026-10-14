/** PEERINFO1：instance 块的组装（白名单）、解析（形状不对整块丢）、开关（off / observe / on）。 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInstanceInfo, OBSERVE_LOG_EVERY_MS, parseInstanceInfo, peerInstanceBlock, peerInstanceInfoMode, resetInstanceObserveLog,
  type InstanceSources, type PeerInstanceInfo,
} from "../src/lib/peer-instance-info";
import { RECOVERY_KEYS } from "../src/lib/recovery-keys";

const SHA = "d9427176deff576232a2b47e0c0dc3a6bb0afd31";
const MODES: Record<string, unknown> = { lendUiUpload: "off", lendUsageReport: "observe", centerReplicaPull: "on" };
const SOURCES: InstanceSources = { version: () => "2.33.0", commit: () => SHA, channel: () => "beta", switchMode: (k) => MODES[k] };
const INFO: PeerInstanceInfo = { version: "2.33.0", commit: SHA, channel: "beta", switches: { lendUiUpload: "off", lendUsageReport: "observe", centerReplicaPull: "on" } };

describe("[验收线 1] 组装只从白名单取值", () => {
  test("正常：四个字段 + 三个开关键，别的什么都没有", () => {
    const info = buildInstanceInfo(SOURCES);
    expect(info).toEqual(INFO);
    expect(Object.keys(info).sort()).toEqual(["channel", "commit", "switches", "version"]);
  });

  test("取值函数带出路径 / 主机名 / agent 名单 / 配置原文：一个都不进 instance", () => {
    const secrets = ["/Users/someone/repos/claudestra", "mbp-someone.local", "agent-secret-x", '{"autoUpdate":{"channel":"beta"}}'];
    const info = buildInstanceInfo({
      version: () => ({ version: "2.33.0", path: secrets[0] }),
      commit: () => `${SHA}\n${secrets[1]}`,
      channel: () => secrets[3],
      switchMode: (k) => (k === "lendUiUpload" ? { mode: "on", agents: [secrets[2]] } : k === "lendUsageReport" ? secrets[0] : "on"),
    });
    const text = JSON.stringify(info);
    for (const s of secrets) expect(text).not.toContain(s);
    expect(text).not.toContain("someone");
    expect(info).toEqual({ version: null, commit: null, channel: null, switches: { centerReplicaPull: "on" } });
  });

  test("三个开关键缺一个只少那个键；取值抛错同样当读不到", () => {
    for (const missing of ["lendUiUpload", "lendUsageReport", "centerReplicaPull"]) {
      const info = buildInstanceInfo({ ...SOURCES, switchMode: (k) => { if (k === missing) throw new Error("x"); return MODES[k]; } });
      expect(Object.keys(info.switches).sort()).toEqual(Object.keys(MODES).filter((k) => k !== missing).sort());
      expect(info.version).toBe("2.33.0");
    }
    expect(buildInstanceInfo({ ...SOURCES, switchMode: () => undefined }).switches).toEqual({});
  });

  test("commit 读不到 / 不是完整 40 位：null", () => {
    expect(buildInstanceInfo({ ...SOURCES, commit: () => null }).commit).toBeNull();
    expect(buildInstanceInfo({ ...SOURCES, commit: () => SHA.slice(0, 12) }).commit).toBeNull();
    expect(buildInstanceInfo({ ...SOURCES, commit: () => { throw new Error("no git"); } }).commit).toBeNull();
  });

  test("恢复键表有 peerInstanceInfo", () => {
    expect(RECOVERY_KEYS as readonly string[]).toContain("peerInstanceInfo");
  });
});

describe("解析：形状不对整块丢，多余字段不留", () => {
  test("合法 → 只留白名单字段；switches 里不认识的键忽略", () => {
    expect(parseInstanceInfo({ ...INFO, host: "x", switches: { ...INFO.switches, futureKey: "on" } })).toEqual(INFO);
    expect(parseInstanceInfo({ version: null, commit: null, channel: null, switches: {} })).toEqual({ version: null, commit: null, channel: null, switches: {} });
  });

  test("形状不对 → null", () => {
    for (const bad of [null, "x", [], { ...INFO, commit: "abc" }, { ...INFO, version: 2 }, { ...INFO, switches: null },
      { ...INFO, switches: { lendUiUpload: "maybe" } }, { version: "1", commit: null, channel: null }]) {
      expect(parseInstanceInfo(bad)).toBeNull();
    }
  });
});

describe("开关 peerInstanceInfo", () => {
  beforeEach(() => resetInstanceObserveLog());

  test("off：不带、不记；on：带", () => {
    const logs: string[] = [];
    expect(peerInstanceBlock("p", { mode: () => "off", info: () => INFO, log: (l) => logs.push(l) })).toBeUndefined();
    expect(logs).toEqual([]);
    expect(peerInstanceBlock("p", { mode: () => "on", info: () => INFO, log: (l) => logs.push(l) })).toEqual(INFO);
    expect(logs).toEqual([]);
  });

  test("[验收线 2] observe：不带，记一行键名（不带值），10 分钟最多一行", () => {
    const logs: string[] = [];
    let now = 1_000_000;
    const d = { mode: () => "observe" as const, info: () => INFO, log: (l: string) => logs.push(l), now: () => now };
    expect(peerInstanceBlock("peer-a", d)).toBeUndefined();
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("version, commit, channel, switches.lendUiUpload, switches.lendUsageReport, switches.centerReplicaPull");
    for (const v of ["2.33.0", SHA.slice(0, 7), "beta"]) expect(logs[0]).not.toContain(v);
    now += OBSERVE_LOG_EVERY_MS - 1;
    peerInstanceBlock("peer-a", d);
    expect(logs.length).toBe(1);
    now += 1;
    peerInstanceBlock("peer-b", d);
    expect(logs.length).toBe(2);
  });

  test("档位读法：没设 = observe；文件坏 = off（不发）", () => {
    const dir = mkdtempSync(join(tmpdir(), "peerinfo-mode-"));
    expect(peerInstanceInfoMode(join(dir, "missing.json"))).toBe("observe");
    writeFileSync(join(dir, "bad.json"), "{not json");
    expect(peerInstanceInfoMode(join(dir, "bad.json"))).toBe("off");
  });
});
