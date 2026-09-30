/** 完成检查单的纯判定（src/lib/ledger-probes.ts）：推断与 extra 只加不减、每个探针的 pass / fail / unknown、豁免与总结论、事务内复核 */
import { describe, expect, test } from "bun:test";
import type { DaemonsOf } from "../src/lib/ledger-daemon-map.js";
import {
  checklistVerdict,
  checksAllClear,
  inferGroups,
  judgeProbe,
  parseExtraChecks,
  planChecklist,
  type ProbeId,
  type VerifyFacts,
} from "../src/lib/ledger-probes.js";

const MERGED_AT = Date.parse("2026-09-28T12:00:00Z");
const PULLED_AT = MERGED_AT + 120_000;

function facts(over: Partial<VerifyFacts> = {}): VerifyFacts {
  return {
    pr: { ref: "https://github.com/o/r/pull/150", state: "MERGED", head: "aaaa111", branch: "task/x", mergeCommit: "bbbb222", mergedAt: MERGED_AT, files: [] },
    taskBranch: "task/x",
    mergeInMain: true,
    expectedWeb: "cccc333",
    webLocal: { commit: "cccc333", contains: true },
    webRelay: { applicable: true, commit: "cccc333", contains: true },
    daemons: { bridge: { pid: "42", installed: true, startedAt: PULLED_AT + 60_000, cwd: "/repo", codeHasMerge: true, worktreeClean: true, headSince: PULLED_AT } },
    evidence: { path: null, bytes: null },
    ...over,
  };
}

const status = (id: ProbeId, f: VerifyFacts) => judgeProbe(id, f).status;
const bridge = (d: Partial<NonNullable<VerifyFacts["daemons"]["bridge"]>>) => facts({ daemons: { bridge: { ...facts().daemons.bridge!, ...d } } });

describe("检查单推断", () => {
  test("web/ 下非 md → web；daemon 按注入的 import 映射；默认映射里 src/lib 四个 daemon 都算", () => {
    expect(inferGroups(["web/features/x.tsx"])).toEqual(["web"]);
    expect(inferGroups(["web/CLAUDE.md", "web/docs/a.md"])).toEqual([]);
    expect(inferGroups(["src/bridge/router.ts"])).toEqual(["bridge"]);
    expect(inferGroups(["src/lib/x.ts"])).toEqual(["bridge", "cron", "scheduler", "launcher"]);
    expect(inferGroups(["src/channel-server.ts", "docs/a.md", "src/manager/ledger.ts"])).toEqual([]);
    const byImport: DaemonsOf = (f) => (f === "src/lib/only-cron.ts" ? ["cron"] : []);
    expect(inferGroups(["src/lib/only-cron.ts", "src/lib/unused.ts"], byImport)).toEqual(["cron"]);
  });
  test("有 PR 有文件：推断；extra 只能加项（并集），不能减", () => {
    const d: DaemonsOf = (f) => (f.startsWith("src/bridge/") ? ["bridge"] : []);
    expect(planChecklist({ hasPr: true, files: ["web/a.ts", "src/bridge/b.ts"], extraChecks: null, daemonsOf: d })).toEqual({
      probes: ["pr-merged", "web-local", "web-relay", "daemon-bridge"], source: "files", incomplete: false,
    });
    const withExtra = planChecklist({ hasPr: true, files: ["web/a.ts", "src/bridge/b.ts"], extraChecks: ["cron"], daemonsOf: d });
    expect(withExtra).toEqual({ probes: ["pr-merged", "web-local", "web-relay", "daemon-bridge", "daemon-cron"], source: "files+extra", incomplete: false });
  });
  test("文件列表拿不到 / 为空：有 extra 才用 extra 顶替，否则 incomplete；没 PR 只核证据（extra 可加项）", () => {
    expect(planChecklist({ hasPr: true, files: null, extraChecks: ["web"] })).toMatchObject({ probes: ["pr-merged", "web-local", "web-relay"], source: "extra" });
    expect(planChecklist({ hasPr: true, files: [], extraChecks: null })).toMatchObject({ probes: ["pr-merged"], incomplete: true });
    expect(planChecklist({ hasPr: false, files: null, extraChecks: null })).toEqual({ probes: ["manual-evidence"], source: "evidence", incomplete: false });
  });
  test("extra.checks：空数组 / 不是数组 / 未知组名都报错", () => {
    expect(parseExtraChecks(undefined)).toBeNull();
    expect(parseExtraChecks(["web", "web", "cron"])).toEqual(["web", "cron"]);
    for (const bad of [[], "web", ["webb"]]) expect(() => parseExtraChecks(bad)).toThrow("extra.checks");
  });
});

describe("pr-merged", () => {
  test("合并、分支对得上、合并提交在 origin/main → pass（squash / rebase 合并也看合并提交，不看 head）", () => {
    expect(judgeProbe("pr-merged", facts())).toMatchObject({ status: "pass", detail: "PR #150 已合并，合并提交 bbbb222 在 origin/main 里" });
  });
  test("没合并 / 任务没记分支 / 分支对不上 → fail；gh 查不到 → unknown", () => {
    expect(judgeProbe("pr-merged", facts({ pr: { ...facts().pr!, state: "OPEN" } }))).toMatchObject({ status: "fail", params: { state: "OPEN" } });
    expect(judgeProbe("pr-merged", facts({ taskBranch: null })).detail).toContain("task-set --branch");
    expect(judgeProbe("pr-merged", facts({ pr: { ...facts().pr!, branch: "task/other" } }))).toMatchObject({ status: "fail", params: { branch: "task/other", taskBranch: "task/x" } });
    expect(status("pr-merged", facts({ pr: { ...facts().pr!, error: "HTTP 502" } }))).toBe("unknown");
  });
  test("合并提交不在 origin/main：fetch 成功 → fail；fetch 失败 / 判不了 → unknown", () => {
    expect(status("pr-merged", facts({ mergeInMain: false }))).toBe("fail");
    expect(status("pr-merged", facts({ mergeInMain: false, fetchError: "network" }))).toBe("unknown");
    expect(status("pr-merged", facts({ mergeInMain: null }))).toBe("unknown");
  });
});

describe("web-local / web-relay", () => {
  test("部署版本等于或是期望提交的后代 → pass；不包含 → fail；认不出 → unknown", () => {
    expect(status("web-local", facts())).toBe("pass");
    expect(judgeProbe("web-local", facts({ webLocal: { commit: "0000999", contains: false } })).detail).toContain("还没部署");
    expect(status("web-local", facts({ webLocal: { commit: "ffff000", contains: null } }))).toBe("unknown");
  });
  test("本机没托管网页 → fail；读失败、找不到期望提交 → unknown", () => {
    expect(status("web-local", facts({ webLocal: { commit: null, contains: null } }))).toBe("fail");
    expect(status("web-local", facts({ webLocal: { commit: null, contains: null, error: "EACCES" } }))).toBe("unknown");
    expect(status("web-local", facts({ expectedWeb: null }))).toBe("unknown");
  });
  test("中继：没配 → pass（不适用）；拿不到 build-info → unknown；落后 → fail，文案写中继", () => {
    expect(judgeProbe("web-relay", facts({ webRelay: { applicable: false, commit: null, contains: null } })).detail).toContain("不适用");
    expect(status("web-relay", facts({ webRelay: { applicable: true, commit: null, contains: null, error: "拿不到" } }))).toBe("unknown");
    expect(judgeProbe("web-relay", facts({ webRelay: { applicable: true, commit: "0000999", contains: false } })).detail).toStartWith("中继网页是");
  });
});

describe("daemon-*", () => {
  test("代码目录含合并提交、启动晚于 HEAD 开始含它的时刻 → pass", () => {
    expect(status("daemon-bridge", facts())).toBe("pass");
  });
  test("合并后没 ff 就重启：代码目录不含合并提交 → fail，哪怕启动晚于合并", () => {
    expect(judgeProbe("daemon-bridge", bridge({ codeHasMerge: false, headSince: null }))).toMatchObject({ status: "fail", detail: expect.stringContaining("先把那里更新到 main") });
  });
  test("先重启、后 ff：启动晚于合并但早于 HEAD 含合并提交的时刻 → fail", () => {
    const r = judgeProbe("daemon-bridge", bridge({ startedAt: MERGED_AT + 30_000, headSince: PULLED_AT }));
    expect(r).toMatchObject({ status: "fail", detail: expect.stringContaining("还没重启") });
  });
  test("启动与代码更新在同一秒（两边都是秒精度）→ pass，不误判成还没重启（T68g）", () => {
    expect(judgeProbe("daemon-bridge", bridge({ startedAt: PULLED_AT, headSince: PULLED_AT }))).toMatchObject({ status: "pass" });
    expect(status("daemon-bridge", bridge({ startedAt: PULLED_AT - 1000, headSince: PULLED_AT }))).toBe("fail");
  });
  test("HEAD 含合并提交但工作区还是旧文件（reset --soft / 手改）→ fail", () => {
    expect(judgeProbe("daemon-bridge", bridge({ worktreeClean: false }))).toMatchObject({ status: "fail", detail: expect.stringContaining("和 HEAD 不一致") });
  });
  test("工作目录不是 git 仓库 → unknown 并写明原因（不再说成「不含合并提交」）", () => {
    expect(judgeProbe("daemon-bridge", bridge({ codeError: "不是 git 仓库", codeHasMerge: undefined }))).toMatchObject({ status: "unknown", detail: expect.stringContaining("不是 git 仓库") });
  });
  test("没装与装了没在跑分开报；没装提示可以豁免", () => {
    expect(judgeProbe("daemon-bridge", bridge({ pid: null, installed: false })).detail).toContain("--waive");
    expect(judgeProbe("daemon-bridge", bridge({ pid: null, installed: true })).detail).toContain("装了但没在跑");
  });
  test("启动与代码更新落在同一分钟：显示到秒", () => {
    const same = judgeProbe("daemon-bridge", bridge({ startedAt: PULLED_AT + 20_000, headSince: PULLED_AT + 5_000 }));
    expect(String(same.params.started)).toMatch(/:\d\d:\d\d$/);
    expect(String(judgeProbe("daemon-bridge", facts()).params.started)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  });
  test("没在跑 → fail；读不到启动时间 / 工作目录 / reflog / 合并时间 → unknown", () => {
    expect(status("daemon-bridge", bridge({ pid: null }))).toBe("fail");
    expect(status("daemon-bridge", bridge({ startedAt: null }))).toBe("unknown");
    expect(status("daemon-bridge", bridge({ cwd: null }))).toBe("unknown");
    expect(status("daemon-bridge", bridge({ codeHasMerge: null }))).toBe("unknown");
    expect(status("daemon-bridge", bridge({ headSince: null }))).toBe("unknown");
    expect(status("daemon-bridge", facts({ pr: { ...facts().pr!, mergedAt: null } }))).toBe("unknown");
    expect(status("daemon-cron", facts())).toBe("unknown"); // 没采集
  });
});

describe("manual-evidence", () => {
  test("没带 / 不存在 / 空文件 → fail；非空 → pass", () => {
    expect(status("manual-evidence", facts())).toBe("fail");
    expect(status("manual-evidence", facts({ evidence: { path: "a.md", bytes: null } }))).toBe("fail");
    expect(status("manual-evidence", facts({ evidence: { path: "a.md", bytes: 0 } }))).toBe("fail");
    expect(judgeProbe("manual-evidence", facts({ evidence: { path: "a.md", bytes: 12 } }))).toMatchObject({
      status: "pass", tpl: "证据 {path}（{bytes} 字节）", params: { path: "a.md", bytes: 12 },
    });
  });
});

describe("总结论、豁免、事务内复核", () => {
  const plan = planChecklist({ hasPr: true, files: ["web/a.ts", "src/bridge.ts"], extraChecks: null, daemonsOf: (f) => (f === "src/bridge.ts" ? ["bridge"] : []) });
  const judge = (f: VerifyFacts) => plan.probes.map((id) => judgeProbe(id, f));
  test("全过 → pass；有 fail → fail（即使还有 unknown）；只有 unknown → unknown", () => {
    expect(checklistVerdict(plan, judge(facts())).result).toBe("pass");
    const mixed = facts({ webLocal: { commit: "0", contains: false }, webRelay: { applicable: true, commit: null, contains: null, error: "x" } });
    expect(checklistVerdict(plan, judge(mixed))).toMatchObject({ result: "fail", blocking: [{ id: "web-local" }, { id: "web-relay" }] });
    expect(checklistVerdict(plan, judge(facts({ mergeInMain: null }))).result).toBe("unknown");
  });
  test("豁免没过的项 → 不再挡；不在单里 / 已通过 / pr-merged → 报错", () => {
    const f = facts({ webRelay: { applicable: true, commit: null, contains: null, error: "中继维护" } });
    const v = checklistVerdict(plan, judge(f), { "web-relay": "中继维护中，owner 同意先放行" });
    expect(v.result).toBe("pass");
    expect(v.checks.find((c) => c.id === "web-relay")).toMatchObject({ status: "unknown", waived: "中继维护中，owner 同意先放行" });
    expect(() => checklistVerdict(plan, judge(f), { "daemon-cron": "x" })).toThrow("不在这次的检查单里");
    expect(() => checklistVerdict(plan, judge(f), { "web-local": "x" })).toThrow("已经通过");
    const open = facts({ pr: { ...facts().pr!, state: "OPEN" } });
    expect(() => checklistVerdict(plan, judge(open), { "pr-merged": "先放行" })).toThrow("不能豁免");
  });
  test("检查单推断不全：结论恒为 unknown", () => {
    const partial = planChecklist({ hasPr: true, files: null, extraChecks: null });
    expect(checklistVerdict(partial, partial.probes.map((id) => judgeProbe(id, facts()))).result).toBe("unknown");
  });
  test("checksAllClear：空 / 有没过没豁免 / 豁免 pr-merged / 空理由 / 未知 id 都不算", () => {
    const ok = judge(facts());
    expect(checksAllClear(ok)).toBe(true);
    expect(checksAllClear([])).toBe(false);
    expect(checksAllClear(undefined)).toBe(false);
    expect(checksAllClear([{ ...ok[1], status: "fail" }])).toBe(false);
    expect(checksAllClear([{ ...ok[1], status: "fail", waived: "理由" }])).toBe(true);
    expect(checksAllClear([{ ...ok[1], status: "fail", waived: "  " }])).toBe(false);
    expect(checksAllClear([{ ...ok[0], status: "fail", waived: "理由" }])).toBe(false);
    expect(checksAllClear([{ id: "nope", status: "pass" }])).toBe(false);
    expect(checksAllClear(ok, true)).toBe(false); // 检查单推断不全：全过也不放行
  });
});
