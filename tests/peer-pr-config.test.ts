/** i28-A2 §1 peer-prs.json：严格解析、全有或全无；没文件 / enabled:false = 关；repoDir 只从 scheduler.json 来。 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePeerPrConfig, peerOfLogin, readPeerPrConfig } from "../src/lib/peer-pr-config.ts";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.ts";

const SCHED = parseSchedulerConfig({ enabled: true, autoDispatch: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: "/repo/p" } } });
const PEER = { peer: "he", fp: "0a1b-2c3d-4e5f-6a7b", agent: "agent-x", githubLogins: ["He-Dev"], authorFamily: "claude" };
const RAW = { enabled: true, project: "p", fromNumber: 311, replyTo: "agent-claudestra@me", peers: [PEER] };

describe("parsePeerPrConfig", () => {
  test("默认值、login 小写、repoDir 取 scheduler.json", () => {
    const c = parsePeerPrConfig(RAW, SCHED)!;
    expect(c).toMatchObject({ project: "p", repoDir: "/repo/p", pollSec: 60, headSettleSec: 90, maxOpen: 2, maxRounds: 2, extraSecurityGlobs: [] });
    expect(c.peers[0]!.githubLogins).toEqual(["he-dev"]);
    expect(peerOfLogin(c, "HE-DEV")?.peer).toBe("he");
    expect(peerOfLogin(c, "nobody")).toBeNull();
  });

  test("enabled:false = 关", () => {
    expect(parsePeerPrConfig({ enabled: false }, SCHED)).toBeNull();
  });

  const bad: [string, Record<string, unknown>][] = [
    ["项目不在 scheduler.json", { project: "q" }],
    ["fp 格式", { peers: [{ ...PEER, fp: "ABCD" }] }],
    ["agent 名", { peers: [{ ...PEER, agent: "a b;rm" }] }],
    ["login 两个 peer 重复", { peers: [PEER, { ...PEER, peer: "he2" }] }],
    ["authorFamily", { peers: [{ ...PEER, authorFamily: "gpt" }] }],
    ["maxOpen 上限 4", { maxOpen: 5 }],
    ["maxRounds 上限 3", { maxRounds: 4 }],
    ["pollSec 下限 30", { pollSec: 5 }],
    ["replyTo 要带 @", { replyTo: "agent-claudestra" }],
    ["额外规则字符", { extraSecurityGlobs: ["$(rm)"] }],
    ["没有 fromNumber", { fromNumber: undefined }],
  ];
  for (const [why, over] of bad) {
    test(`拒：${why}`, () => {
      expect(() => parsePeerPrConfig({ ...RAW, ...over }, SCHED)).toThrow();
    });
  }
});

describe("readPeerPrConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "peer-prs-"));
  const path = join(dir, "peer-prs.json");
  test("没文件 = off，坏 JSON / 不合法 = error，合法 = on", () => {
    expect(readPeerPrConfig(path, () => SCHED)).toEqual({ kind: "off" });
    writeFileSync(path, "{");
    expect(readPeerPrConfig(path, () => SCHED).kind).toBe("error");
    writeFileSync(path, JSON.stringify({ ...RAW, maxOpen: 9 }));
    expect(readPeerPrConfig(path, () => SCHED).kind).toBe("error");
    writeFileSync(path, JSON.stringify(RAW));
    expect(readPeerPrConfig(path, () => SCHED).kind).toBe("on");
    writeFileSync(path, JSON.stringify({ enabled: false }));
    expect(readPeerPrConfig(path, () => SCHED)).toEqual({ kind: "off" });
    rmSync(dir, { recursive: true, force: true });
  });
});
