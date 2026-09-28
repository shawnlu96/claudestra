/** 完成检查单的纯判定（src/lib/ledger-probes.ts）：按文件推断、extra.checks 覆盖、每个探针的 pass / fail / unknown、豁免与总结论 */
import { describe, expect, test } from "bun:test";
import {
  checklistVerdict,
  inferGroups,
  judgeProbe,
  parseExtraChecks,
  planChecklist,
  type ProbeId,
  type VerifyFacts,
} from "../src/lib/ledger-probes.js";

const MERGED_AT = Date.parse("2026-09-28T12:00:00Z");

function facts(over: Partial<VerifyFacts> = {}): VerifyFacts {
  return {
    pr: { ref: "#150", state: "MERGED", head: "aaaa111", mergeCommit: "bbbb222", mergedAt: MERGED_AT, files: [] },
    headInMain: true,
    expectedWeb: "cccc333",
    webLocal: { commit: "cccc333", contains: true },
    webRelay: { applicable: true, commit: "cccc333", contains: true },
    daemons: { bridge: { pid: "42", startedAt: MERGED_AT + 60_000 } },
    evidence: { path: null, bytes: null },
    ...over,
  };
}

const status = (id: ProbeId, f: VerifyFacts) => judgeProbe(id, f).status;

describe("检查单推断", () => {
  test("web/ 下非 md → web；src/bridge*、src/lib/** → bridge；cron / launcher 各自；channel-server、文档不算", () => {
    expect(inferGroups(["web/features/x.tsx"])).toEqual(["web"]);
    expect(inferGroups(["web/CLAUDE.md", "web/docs/a.md"])).toEqual([]);
    expect(inferGroups(["src/bridge.ts"])).toEqual(["bridge"]);
    expect(inferGroups(["src/bridge/router.ts", "src/lib/x.ts"])).toEqual(["bridge"]);
    expect(inferGroups(["src/cron.ts", "src/launcher.ts"])).toEqual(["cron", "launcher"]);
    expect(inferGroups(["src/channel-server.ts", "docs/a.md", "tests/x.test.ts", "src/manager/ledger.ts"])).toEqual([]);
    expect(inferGroups(["src/bridgework.ts"])).toEqual([]); // 只认 src/bridge.ts 与 src/bridge/ 目录，不按前缀误伤
  });
  test("有 PR：pr-merged 打头 + 按文件推断；没有 PR：只有 manual-evidence", () => {
    expect(planChecklist({ hasPr: true, files: ["web/a.ts", "src/lib/b.ts"], extraChecks: null })).toEqual({
      probes: ["pr-merged", "web-local", "web-relay", "daemon-bridge"], source: "files", incomplete: false,
    });
    expect(planChecklist({ hasPr: false, files: null, extraChecks: null })).toEqual({ probes: ["manual-evidence"], source: "files", incomplete: false });
  });
  test("extra.checks 替换推断的那部分；有 PR 却拿不到文件列表又没手工指定 → incomplete", () => {
    expect(planChecklist({ hasPr: true, files: ["web/a.ts"], extraChecks: ["bridge"] }).probes).toEqual(["pr-merged", "daemon-bridge"]);
    expect(planChecklist({ hasPr: false, files: null, extraChecks: ["web"] }).probes).toEqual(["manual-evidence", "web-local", "web-relay"]);
    expect(planChecklist({ hasPr: true, files: null, extraChecks: null }).incomplete).toBe(true);
    expect(planChecklist({ hasPr: true, files: null, extraChecks: [] })).toMatchObject({ probes: ["pr-merged"], incomplete: false });
  });
  test("extra.checks 写错（不是数组 / 未知组名）直接报错，不静默少核一项", () => {
    expect(parseExtraChecks(undefined)).toBeNull();
    expect(parseExtraChecks(["web", "web", "cron"])).toEqual(["web", "cron"]);
    expect(() => parseExtraChecks("web")).toThrow("extra.checks");
    expect(() => parseExtraChecks(["webb"])).toThrow("extra.checks");
  });
});

describe("pr-merged", () => {
  test("合并且 head 在 origin/main → pass；没合并 → fail；gh 查不到 → unknown", () => {
    expect(status("pr-merged", facts())).toBe("pass");
    expect(judgeProbe("pr-merged", facts({ pr: { ...facts().pr!, state: "OPEN" } }))).toMatchObject({ status: "fail", detail: expect.stringContaining("OPEN") });
    expect(status("pr-merged", facts({ pr: { ...facts().pr!, error: "HTTP 502" } }))).toBe("unknown");
  });
  test("head 不在 origin/main：fetch 成功 → fail；fetch 失败 → unknown（本地 origin/main 可能是旧的）", () => {
    expect(status("pr-merged", facts({ headInMain: false }))).toBe("fail");
    expect(status("pr-merged", facts({ headInMain: false, fetchError: "network" }))).toBe("unknown");
    expect(status("pr-merged", facts({ headInMain: null }))).toBe("unknown");
  });
});

describe("web-local / web-relay", () => {
  test("部署版本等于或是期望提交的后代 → pass；不包含 → fail；认不出 → unknown", () => {
    expect(status("web-local", facts())).toBe("pass");
    expect(status("web-local", facts({ webLocal: { commit: "dddd444", contains: true } }))).toBe("pass");
    expect(judgeProbe("web-local", facts({ webLocal: { commit: "0000999", contains: false } }))).toMatchObject({ status: "fail", detail: expect.stringContaining("还没部署") });
    expect(status("web-local", facts({ webLocal: { commit: "ffff000", contains: null } }))).toBe("unknown");
  });
  test("本机没托管网页 → fail；读失败、找不到期望提交 → unknown", () => {
    expect(status("web-local", facts({ webLocal: { commit: null, contains: null } }))).toBe("fail");
    expect(status("web-local", facts({ webLocal: { commit: null, contains: null, error: "EACCES" } }))).toBe("unknown");
    expect(status("web-local", facts({ expectedWeb: null }))).toBe("unknown");
  });
  test("中继：没配 → pass（不适用）；配了但拿不到 build-info → unknown；落后 → fail", () => {
    expect(judgeProbe("web-relay", facts({ webRelay: { applicable: false, commit: null, contains: null } }))).toMatchObject({ status: "pass", detail: expect.stringContaining("不适用") });
    expect(status("web-relay", facts({ webRelay: { applicable: true, commit: null, contains: null, error: "拿不到" } }))).toBe("unknown");
    expect(status("web-relay", facts({ webRelay: { applicable: true, commit: "0000999", contains: false } }))).toBe("fail");
  });
});

describe("daemon-* 与 manual-evidence", () => {
  test("启动晚于合并 → pass；早于 → fail；没在跑 → fail；读不到时间 / 合并时间 / 进程 → unknown", () => {
    expect(status("daemon-bridge", facts())).toBe("pass");
    expect(judgeProbe("daemon-bridge", facts({ daemons: { bridge: { pid: "42", startedAt: MERGED_AT - 1 } } }))).toMatchObject({ status: "fail", detail: expect.stringContaining("还没重启") });
    expect(status("daemon-bridge", facts({ daemons: { bridge: { pid: null, startedAt: null } } }))).toBe("fail");
    expect(status("daemon-bridge", facts({ daemons: { bridge: { pid: "42", startedAt: null } } }))).toBe("unknown");
    expect(status("daemon-bridge", facts({ pr: { ...facts().pr!, mergedAt: null } }))).toBe("unknown");
    expect(status("daemon-cron", facts())).toBe("unknown"); // 没采集
    expect(status("daemon-cron", facts({ daemons: { cron: { pid: null, startedAt: null, error: "launchctl list 失败" } } }))).toBe("unknown");
  });
  test("证据：没带 / 不存在 / 空文件 → fail；非空 → pass", () => {
    expect(status("manual-evidence", facts())).toBe("fail");
    expect(status("manual-evidence", facts({ evidence: { path: "a.md", bytes: null } }))).toBe("fail");
    expect(status("manual-evidence", facts({ evidence: { path: "a.md", bytes: 0 } }))).toBe("fail");
    expect(status("manual-evidence", facts({ evidence: { path: "a.md", bytes: 12 } }))).toBe("pass");
  });
});

describe("总结论与豁免", () => {
  const plan = planChecklist({ hasPr: true, files: ["web/a.ts", "src/bridge.ts"], extraChecks: null });
  const judge = (f: VerifyFacts) => plan.probes.map((id) => judgeProbe(id, f));
  test("全过 → pass；有 fail → fail（即使还有 unknown）；只有 unknown → unknown", () => {
    expect(checklistVerdict(plan, judge(facts())).result).toBe("pass");
    const mixed = facts({ webLocal: { commit: "0", contains: false }, webRelay: { applicable: true, commit: null, contains: null, error: "x" } });
    expect(checklistVerdict(plan, judge(mixed))).toMatchObject({ result: "fail", blocking: [{ id: "web-local" }, { id: "web-relay" }] });
    expect(checklistVerdict(plan, judge(facts({ headInMain: null }))).result).toBe("unknown");
  });
  test("豁免没过的项 → 不再挡，结果里带理由；豁免不在单里 / 已通过的项 → 报错", () => {
    const f = facts({ webRelay: { applicable: true, commit: null, contains: null, error: "中继维护" } });
    const v = checklistVerdict(plan, judge(f), { "web-relay": "中继维护中，owner 同意先放行" });
    expect(v.result).toBe("pass");
    expect(v.checks.find((c) => c.id === "web-relay")).toMatchObject({ status: "unknown", waived: "中继维护中，owner 同意先放行" });
    expect(() => checklistVerdict(plan, judge(f), { "daemon-cron": "x" })).toThrow("不在这次的检查单里");
    expect(() => checklistVerdict(plan, judge(f), { "pr-merged": "x" })).toThrow("已经通过");
  });
  test("检查单推断不全：全豁免也只能是 unknown", () => {
    const partial = planChecklist({ hasPr: true, files: null, extraChecks: null });
    const f = facts({ pr: { ...facts().pr!, error: "gh 没登录", files: null } });
    const v = checklistVerdict(partial, partial.probes.map((id) => judgeProbe(id, f)), { "pr-merged": "gh 坏了" });
    expect(v.result).toBe("unknown");
  });
});
