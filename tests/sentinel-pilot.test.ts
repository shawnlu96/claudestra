/**
 * agents-T14b 哨兵试点：每个应检时刻由代码按运行台账 + 会话记录判六类之一，日报能逐条对账；off / observe / on 三档与幂等。
 * 全部注入时钟、内存运行记录、固定会话行；不连 bridge、tmux、cron daemon。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CronJob } from "../src/lib/cron-job.js";
import { createCronRunStore, type CronRunRecord } from "../src/lib/cron-run-state.js";
import { collectRunEvidence, parseResultLine } from "../src/lib/sentinel-pilot-evidence.js";
import {
  noteDispatch, REPORT_FOOTER, renderReport, reportFileName, reportReadyAt, sentinelPilotMode, setSentinelPilotMode, type SlotStatus,
} from "../src/lib/sentinel-pilot.js";
import {
  buildDayReport, CATCHUP_DAYS, LEDGER_KEEP_FINISHED, sentinelPilotTick, sincePath, type SentinelTickDeps, type SessionLines,
} from "../src/lib/sentinel-pilot-tick.js";
import { cmdSentinelPilot } from "../src/manager/sentinel-pilot-cmds.js";

const DAY = "2026-10-13";
const SLOT = new Date(2026, 9, 13, 15, 30).getTime();
const MIN = 60_000;
const job: CronJob = {
  id: "job1", name: "terrarium-health", schedule: "30 15 * * *", prompt: "检查爬宠缸", dir: "-", enabled: true, createdAt: "x",
  targetAgent: "terrarium", reportChannelId: "123456789012345678",
};
const tempJob: CronJob = { ...job, id: "job2", name: "weekly", targetAgent: undefined };

const iso = (ms: number) => new Date(ms).toISOString();
const run = (over: Partial<CronRunRecord> = {}): CronRunRecord => ({
  key: `job1@${SLOT / MIN}`, jobId: "job1", jobName: job.name, epochMinute: SLOT / MIN, historyId: "h", owner: "o", startedAt: iso(SLOT),
  deadlineAt: iso(SLOT + 40 * MIN), status: "success", dispatchAttemptedAt: iso(SLOT + 1000), finishedAt: iso(SLOT + 10 * MIN), targetSessionId: "sess-1", ...over,
});

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const at = (m: number) => iso(SLOT + m * MIN);
const say = (m: number, text: string) => line({ type: "assistant", timestamp: at(m), message: { content: [{ type: "text", text }] } });
const tool = (m: number, name: string, input: Record<string, unknown>, id = `t${m}`) =>
  line({ type: "assistant", timestamp: at(m), message: { content: [{ type: "tool_use", id, name, input }] } });
const user = (m: number, content: unknown) => line({ type: "user", timestamp: at(m), message: { content } });
const PROMPT = user(0.1, job.prompt);

const WINDOW = { from: SLOT + 1000, to: SLOT + 10 * MIN };

async function statusFor(runs: CronRunRecord[], lines: string[] | null): Promise<{ status: SlotStatus; text: string; reads: number }> {
  let reads = 0;
  const readSession = async (): Promise<SessionLines> => (reads++, lines ? { lines } : { error: "没有" });
  const input = await buildDayReport(job, DAY, runs, readSession, "observe", SLOT + 60 * MIN);
  expect(input.verdicts).toHaveLength(1);
  return { status: input.verdicts[0].status, text: renderReport(input), reads };
}

describe("日报六类（验收 1）", () => {
  test("没有运行记录：没检查", async () => {
    const r = await statusFor([], []);
    expect(r.status).toBe("not_checked");
    expect(r.text).toContain("## 15:30 · 没检查");
    expect(r.text.trim().endsWith(REPORT_FOOTER)).toBe(true);
  });
  test("timeout：失败，附 error 原文", async () => {
    const r = await statusFor([run({ status: "timeout", error: "超时 (30 分钟)" })], []);
    expect(r.status).toBe("failed");
    expect(r.text).toContain("「超时 (30 分钟)」");
  });
  test("success 但没有结果行：未验证", async () => {
    expect((await statusFor([run()], [PROMPT, tool(1, "Read", { file_path: "/x" }), say(2, "看完了，一切好")])).status).toBe("unverified");
  });
  test("发了带按钮的消息：待批准（有结果行也算）", async () => {
    const lines = [PROMPT, tool(1, "mcp__claudestra__reply", { chat_id: "1", text: "要开加热吗？[[{#heat_on .success}开]]" }), say(2, "哨兵结果:异常 — 温度低")];
    expect((await statusFor([run()], lines)).status).toBe("pending_approval");
    const comp = [PROMPT, tool(1, "mcp__claudestra__reply", { chat_id: "1", text: "确认？", components: [{ type: "buttons", buttons: [] }] })];
    expect((await statusFor([run()], comp)).status).toBe("pending_approval");
  });
  test("停在未答提问上：待批准；答了就不算", async () => {
    expect((await statusFor([run()], [PROMPT, tool(1, "AskUserQuestion", { questions: [] }, "q1")])).status).toBe("pending_approval");
    const answered = [PROMPT, tool(1, "AskUserQuestion", { questions: [] }, "q1"), user(2, [{ type: "tool_result", tool_use_id: "q1", content: "a" }]), say(3, "哨兵结果:正常 — ok")];
    expect((await statusFor([run()], answered)).status).toBe("normal");
  });
  test("结果行写异常：异常", async () => {
    const r = await statusFor([run()], [PROMPT, tool(1, "Read", { file_path: "/x" }), say(2, "湿度偏低\n哨兵结果：异常 — 湿度 40%")]);
    expect(r.status).toBe("abnormal");
    expect(r.text).toContain("「异常 — 湿度 40%」");
  });
  test("结果行写正常且只有只读调用：正常，不列越界", async () => {
    const lines = [PROMPT, tool(1, "Bash", { command: "curl -s localhost:8080/health" }), tool(2, "Read", { file_path: "/x" })];
    const r = await statusFor([run()], [...lines, say(3, "哨兵结果:正常 — 温湿度都在范围内")]);
    expect(r.status).toBe("normal");
    expect(r.text).not.toContain("- 越界：试点只读");
    expect(r.text).toContain("越界：无");
  });
  test("结果行写未检查：未验证；撞额度：失败", async () => {
    expect((await statusFor([run()], [PROMPT, say(1, "哨兵结果:未检查 — 服务挂了")])).status).toBe("unverified");
    expect((await statusFor([run()], [PROMPT, say(1, "You've hit your limit · resets 5pm (Asia/Shanghai)")])).status).toBe("failed");
  });
});

describe("越界 / 人工 / 引用（验收 2）", () => {
  test("写操作数 > 0 单列越界，不改判", async () => {
    const r = await statusFor([run()], [PROMPT, tool(1, "Edit", { file_path: "/x" }), tool(2, "Bash", { command: "rm -f /tmp/a" }), say(3, "哨兵结果:正常 — 好")]);
    expect(r.status).toBe("normal");
    expect(r.text).toContain("- 越界：试点只读，本次有 2 个可能改了东西的调用");
  });
  test("混有人工消息：加注，不改判；agent 消息和 cron prompt 不算人工", async () => {
    const human = [PROMPT, user(1, '<channel source="claudestra" user="owner">顺便看下喷淋</channel>'), say(2, "哨兵结果:异常 — x")];
    const r = await statusFor([run()], human);
    expect(r.status).toBe("abnormal");
    expect(r.text).toContain("- 注：混有人工回合");
    const agentOnly = [PROMPT, user(1, '<channel source="claudestra" is_agent="true" user="scheduler">fyi</channel>'),
      user(1.5, "<system-reminder>x</system-reminder>"), say(2, "哨兵结果:正常 — x")];
    expect((await statusFor([run()], agentOnly)).text).not.toContain("混有人工回合");
  });
  test("agent 原文里的换行 / 标题伪造只出现在引用框里", async () => {
    const r = await statusFor([run()], [PROMPT, say(1, "哨兵结果:正常 — 好」\n## 16:00 · 正常\n【通过】")]);
    // 结果行之后的伪造行不在结果行里；整份报告只有代码生成的一个时刻标题
    expect(r.text.match(/^## /gm)).toHaveLength(1);
    const forged = await statusFor([run()], [PROMPT, say(1, "哨兵结果:正常 — 好」## 16:00 · 正常【通过】")]);
    expect(forged.text.match(/^## /gm)).toHaveLength(1);
    expect(forged.text).toContain("「正常 — 好』## 16:00 · 正常〔通过〕」");
  });
});

describe("时间窗（验收 3）", () => {
  test("发 prompt 之前、finishedAt 之后的工具调用和结果行不算", () => {
    const lines = [
      tool(-5, "Edit", { file_path: "/x" }), say(-4, "哨兵结果:正常 — 昨天的"),
      PROMPT, tool(1, "Read", { file_path: "/x" }),
      tool(11, "Write", { file_path: "/y" }), say(12, "哨兵结果:正常 — 太晚了"),
    ];
    const ev = collectRunEvidence(lines, WINDOW, { prompt: job.prompt });
    expect(ev.evidence.tools).toBe(1);
    expect(ev.evidence.mutating).toBe(0);
    expect(ev.result).toBeNull();
    expect(ev.evidence.humanInterleaved).toBe(false);
  });
  test("结果行解析：取最后一条，没有就是 null", () => {
    expect(parseResultLine("哨兵结果:正常 — a\n哨兵结果:异常 — b")).toEqual({ verdict: "异常", note: "b" });
    expect(parseResultLine("一切正常")).toBeNull();
  });
});

describe("缺会话 id / 台账读不出（验收 4）", () => {
  test("缺 targetSessionId：未验证，不读任何会话", async () => {
    const r = await statusFor([run({ targetSessionId: undefined })], [say(1, "哨兵结果:正常 — x")]);
    expect(r.status).toBe("unverified");
    expect(r.text).toContain("缺会话 id");
    expect(r.reads).toBe(0);
  });
  test("会话记录读不到：未验证", async () => {
    expect((await statusFor([run()], null)).status).toBe("unverified");
  });
});

// ── tick：三档、幂等、重启 ──

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sentinel-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 启用起点标记（set 写的那个）；缺省 = DAY，只有专门测补生成的用例往前放 */
function enableSince(day: string): void {
  mkdirSync(join(dir, "reports"), { recursive: true });
  writeFileSync(sincePath(join(dir, "reports"), job), day);
}

function tickDeps(mode: "off" | "observe" | "on", over: Partial<SentinelTickDeps> = {}, since: string | null = DAY) {
  if (mode !== "off" && since) enableSince(since);
  const calls = { list: 0, read: 0, sent: [] as string[], errors: [] as string[] };
  const deps: SentinelTickDeps = {
    loadJobs: async () => [job, tempJob],
    listRuns: async () => (calls.list++, [run()]),
    mode: () => mode,
    readSession: async () => (calls.read++, { lines: [PROMPT, say(1, "哨兵结果:正常 — 好")] }),
    reportsDir: join(dir, "reports"),
    notify: async (_c, text) => (calls.sent.push(text), true),
    log: () => {},
    error: (m) => calls.errors.push(m),
    ...over,
  };
  return { deps, calls };
}
const AFTER = new Date(SLOT + 61 * MIN); // 15:30 + 30 + 30 分钟之后
/** sentinelPilotTick 同一分钟只跑一次（模块内状态）：每次调用取一个新的分钟，都在截止点之后、同一天 */
let nth = 0;
const after = () => new Date(AFTER.getTime() + nth++ * MIN);
const reportPath = () => join(dir, "reports", reportFileName(job, DAY));

describe("sentinelPilotTick（验收 4、5）", () => {
  test("截止点 = 最后一个应检时刻 + maxRuntime + 30 分钟", () => {
    expect(reportReadyAt(job, DAY)).toBe(SLOT + 60 * MIN);
  });
  test("off：不读台账、不读会话、不写、不发", async () => {
    const { deps, calls } = tickDeps("off");
    await sentinelPilotTick(after(), deps);
    expect([calls.list, calls.read, calls.sent.length]).toEqual([0, 0, 0]);
    expect(existsSync(join(dir, "reports"))).toBe(false);
  });
  test("同一分钟只跑一次", async () => {
    const { deps, calls } = tickDeps("observe");
    const t = after();
    await sentinelPilotTick(t, deps);
    rmSync(join(dir, "reports"), { recursive: true, force: true });
    await sentinelPilotTick(t, deps);
    expect(calls.list).toBe(1);
  });
  test("截止点之前不生成", async () => {
    const { deps, calls } = tickDeps("on");
    await sentinelPilotTick(new Date(SLOT + 59 * MIN), deps);
    expect(existsSync(reportPath())).toBe(false);
    expect(calls.sent).toHaveLength(0); // 启用起点是当天：前一天（开之前）不补
  });
  test("observe：只写文件，不发", async () => {
    const { deps, calls } = tickDeps("observe");
    await sentinelPilotTick(after(), deps);
    expect(readFileSync(reportPath(), "utf8")).toContain("## 15:30 · 正常");
    expect(existsSync(`${reportPath()}.sent`)).toBe(false);
    expect(calls.sent).toHaveLength(0);
  });
  test("on：写文件、写 .sent、发一次；同一天连跑两次、模拟重启都不重复", async () => {
    const { deps, calls } = tickDeps("on");
    await sentinelPilotTick(after(), deps);
    await sentinelPilotTick(after(), deps);
    expect(calls.sent).toHaveLength(1);
    expect(calls.sent[0]).toContain(DAY);
    expect(existsSync(`${reportPath()}.sent`)).toBe(true);
    // 重启：新的 deps（内存状态全丢），报告文件已在
    const again = tickDeps("on", {}, null);
    await sentinelPilotTick(after(), again.deps);
    expect([again.calls.list, again.calls.sent.length]).toEqual([0, 0]);
    expect(readdirSync(join(dir, "reports")).filter((f) => f.includes(DAY)).sort()).toEqual([reportFileName(job, DAY), `${reportFileName(job, DAY)}.sent`]);
  });
  test("on：认领后发送失败只记日志，不重发", async () => {
    const { deps, calls } = tickDeps("on", { notify: async () => false });
    await sentinelPilotTick(after(), deps);
    await sentinelPilotTick(after(), deps);
    expect(calls.errors.filter((e) => e.includes("不重发") && e.includes(DAY))).toHaveLength(1);
  });
  test("runStore.list() 抛：本轮不生成，不出现没检查；下一轮再试", async () => {
    let broken = true;
    const { deps, calls } = tickDeps("observe", { listRuns: async () => { if (broken) throw new Error("cron 运行台账读不出: bad json"); return [run()]; } });
    await sentinelPilotTick(after(), deps);
    expect(existsSync(reportPath())).toBe(false);
    expect(calls.errors[0]).toContain("读不出");
    broken = false;
    await sentinelPilotTick(after(), deps);
    expect(readFileSync(reportPath(), "utf8")).not.toContain("## 15:30 · 没检查");
    expect(readFileSync(reportPath(), "utf8")).toContain("## 15:30 · 正常");
  });
  test("睡过头醒来补生成前一天，标出补生成", async () => {
    const { deps } = tickDeps("observe");
    await sentinelPilotTick(new Date(SLOT + 20 * 3_600_000), deps);
    expect(readFileSync(reportPath(), "utf8")).toContain("补生成");
  });
});

describe("会话 id 记录（验收 6）", () => {
  test("list 里有目标 agent：记下 targetSessionId；没有：照常只记 dispatchAttemptedAt", () => {
    const a = run({ dispatchAttemptedAt: undefined, targetSessionId: undefined });
    noteDispatch(a, { sessionId: "s-9", channelId: "c" } as never, "T");
    expect([a.dispatchAttemptedAt, a.targetSessionId]).toEqual(["T", "s-9"]);
    const b = run({ dispatchAttemptedAt: undefined, targetSessionId: undefined });
    noteDispatch(b, undefined, "T");
    expect(b).toEqual(run({ dispatchAttemptedAt: "T", targetSessionId: undefined }));
  });
});

describe("CLI（验收 7）", () => {
  test("set 拒绝临时执行模式的任务；定向任务能切档，文件坏 / 缺按 off", async () => {
    const path = join(dir, "sentinel-pilot.json");
    await expect(setSentinelPilotMode(tempJob, "observe", path)).rejects.toThrow("临时执行模式");
    expect(sentinelPilotMode("job1", path)).toBe("off");
    await setSentinelPilotMode(job, "observe", path);
    expect(sentinelPilotMode("job1", path)).toBe("observe");
    const outs: unknown[] = [];
    await cmdSentinelPilot(["set", "weekly", "on"], { deps: tickDeps("off").deps, out: (d) => outs.push(d), setMode: (j, m) => setSentinelPilotMode(j, m, path) });
    expect(outs[0]).toMatchObject({ ok: false });
  });
  test("report --dry-run 只印不写；不带 --dry-run 拒绝", async () => {
    const { deps } = tickDeps("on", {}, null);
    const outs: unknown[] = [];
    await cmdSentinelPilot(["report", "terrarium-health", "--date", DAY, "--dry-run"], { deps, out: (d) => outs.push(d), mode: () => "on", now: () => AFTER.getTime() });
    expect(String(outs[0])).toContain("## 15:30 · 正常");
    expect(String(outs[0])).toContain("dry-run");
    expect(existsSync(join(dir, "reports"))).toBe(false);
    await cmdSentinelPilot(["report", "terrarium-health"], { deps, out: (d) => outs.push(d) });
    expect(outs[1]).toMatchObject({ ok: false });
  });
  test("show 列定向任务、档位、下一个截止点和结果行约定", async () => {
    const outs: any[] = [];
    await cmdSentinelPilot(["show"], { deps: tickDeps("off").deps, out: (d) => outs.push(d), mode: () => "observe", now: () => SLOT });
    expect(outs[0].jobs).toEqual([expect.objectContaining({ name: "terrarium-health", mode: "observe", nextDeadline: iso(SLOT + 60 * MIN) })]);
    expect(outs[0].resultHint).toContain("哨兵结果:");
  });
});

describe("第 1 轮审查回归", () => {
  test("failed-run-audit-loss：timeout 也读会话，判失败但列越界和人工回合", async () => {
    const lines = [PROMPT, tool(1, "Edit", { file_path: "/x", old_string: "a", new_string: "b" }), user(2, "<channel source=\"claudestra\" user=\"alex\">先别查了</channel>")];
    const r = await statusFor([run({ status: "timeout", error: "超时" })], lines);
    expect(r.status).toBe("failed");
    expect(r.reads).toBe(1);
    expect(r.text).toContain("越界：试点只读，本次有 1 个可能改了东西的调用");
    expect(r.text).toContain("混有人工回合");
    expect(r.text).not.toContain("越界：无");
  });
  test("failed-run-audit-loss：失败且读不到会话，判定里写明越界没核", async () => {
    const r = await statusFor([run({ status: "error", error: "tmux 发送失败" })], null);
    expect(r.status).toBe("failed");
    expect(r.text).toContain("越界和人工回合没核");
  });
  test("stale-result-survives-final-reply：最后一条回复没有结果行就是没有", async () => {
    const ev = collectRunEvidence([PROMPT, say(1, "哨兵结果:正常 — ok"), say(2, "撤回,没查成")], WINDOW, { prompt: job.prompt });
    expect(ev.result).toBeNull();
    expect((await statusFor([run()], [PROMPT, say(1, "哨兵结果:正常 — ok"), say(2, "撤回,没查成")])).status).toBe("unverified");
  });
  test("stale-result-survives-final-reply：结果行之后的纯工具调用不清它；同一条消息拆成多行合在一起看", () => {
    const after = collectRunEvidence([PROMPT, say(1, "哨兵结果:异常 — 偏冷"), tool(2, "Read", { file_path: "/x" })], WINDOW, { prompt: job.prompt });
    expect(after.result).toEqual({ verdict: "异常", note: "偏冷" });
    const part = (m: number, text: string) => line({ type: "assistant", timestamp: at(m), message: { id: "msg1", content: [{ type: "text", text }] } });
    const split = collectRunEvidence([PROMPT, part(1, "哨兵结果:正常 — 好"), part(1.5, "以上")], WINDOW, { prompt: job.prompt });
    expect(split.result).toEqual({ verdict: "正常", note: "好" });
  });
});

describe("复现（第 2 轮审查）", () => {
  test("stale-result-survives-final-reply：同一条消息里两次 reply，各自是一条回复，以最后一次为准", () => {
    const reply = (text: string, id: string) => ({ type: "tool_use", id, name: "mcp__claudestra__reply", input: { chat_id: "1", text } });
    const both = line({ type: "assistant", timestamp: at(1), message: { id: "m1", content: [reply("哨兵结果:正常 — ok", "r1"), reply("撤回,没查成", "r2")] } });
    expect(collectRunEvidence([PROMPT, both], WINDOW, { prompt: job.prompt }).result).toBeNull();
    const kept = line({ type: "assistant", timestamp: at(1), message: { id: "m1", content: [reply("撤回", "r1"), reply("哨兵结果:异常 — 偏冷", "r2")] } });
    expect(collectRunEvidence([PROMPT, kept], WINDOW, { prompt: job.prompt }).result).toEqual({ verdict: "异常", note: "偏冷" });
  });
  test("ledger-coverage-suppresses-missed-run：台账没到裁剪条数，较晚的别的记录不能压掉没检查", async () => {
    const other = run({ key: "other@x", jobId: "other", epochMinute: (SLOT + 30 * MIN) / MIN });
    const { deps, calls } = tickDeps("observe", { listRuns: async () => [other] }, DAY);
    await sentinelPilotTick(after(), deps);
    expect(readFileSync(reportPath(), "utf8")).toContain("## 15:30 · 没检查");
    expect(calls.errors.filter((e) => e.includes("不补"))).toHaveLength(0);
  });
});

describe("补生成范围（审查 catchup-limited-to-yesterday）", () => {
  const days = ["2026-10-10", "2026-10-11", "2026-10-12", DAY, "2026-10-14", "2026-10-15"];
  const old = run({ key: "other@1", jobId: "other", epochMinute: new Date(2026, 9, 1).getTime() / MIN });
  const late = (d: number) => new Date(new Date(2026, 9, 15, 20, 0).getTime() + d * MIN);

  test("停了多天醒来：启用起点到今天缺的日报都补上，标补生成", async () => {
    const { deps } = tickDeps("observe", { listRuns: async () => [old, run()] }, "2026-10-10");
    await sentinelPilotTick(late(0), deps);
    const files = readdirSync(join(dir, "reports")).filter((f) => f.endsWith(".md")).sort();
    expect(files).toEqual(days.map((d) => reportFileName(job, d)));
    expect(readFileSync(join(dir, "reports", reportFileName(job, "2026-10-11")), "utf8")).toContain("## 15:30 · 没检查");
    expect(readFileSync(reportPath(), "utf8")).toContain("补生成");
  });
  test("不早于启用起点，也不早于 CATCHUP_DAYS 天前", async () => {
    const { deps } = tickDeps("observe", { listRuns: async () => [old, run()] }, "2026-09-01");
    await sentinelPilotTick(late(1), deps);
    expect(readdirSync(join(dir, "reports")).filter((f) => f.endsWith(".md"))).toHaveLength(CATCHUP_DAYS);
  });
  test("没有启用起点：以今天为起点写下，不补更早", async () => {
    const { deps } = tickDeps("observe", { listRuns: async () => [old, run()] }, null);
    await sentinelPilotTick(late(2), deps);
    expect(readdirSync(join(dir, "reports")).filter((f) => f.endsWith(".md"))).toEqual([reportFileName(job, "2026-10-15")]);
    expect(readFileSync(sincePath(join(dir, "reports"), job), "utf8")).toBe("2026-10-15");
  });
  test("台账已裁到某天之后：那几天不补（不判没检查），只报一次", async () => {
    // 结束记录到了裁剪条数，最早一条在 10-13 当天之内（应检时刻之后则被裁的就是之前那些天）
    const filler = Array.from({ length: LEDGER_KEEP_FINISHED }, (_, i) =>
      run({ key: `other@${i}`, jobId: "other", epochMinute: new Date(2026, 9, 13, 0, 1).getTime() / MIN + i }));
    const { deps, calls } = tickDeps("observe", { listRuns: async () => [...filler, run()] }, "2026-10-10");
    await sentinelPilotTick(late(3), deps);
    await sentinelPilotTick(late(4), deps);
    const files = readdirSync(join(dir, "reports")).filter((f) => f.endsWith(".md")).sort();
    expect(files).toEqual([DAY, "2026-10-14", "2026-10-15"].map((d) => reportFileName(job, d)));
    expect(calls.errors.filter((e) => e.includes("不补"))).toHaveLength(3);
  });
  test("LEDGER_KEEP_FINISHED 和 cron-run-state 的真实裁剪条数一致", async () => {
    // 默认条数的真实 store：放 KEEP+1 条老的结束记录，下一次写就裁成 KEEP 条
    let data: unknown = { version: 1, runs: Array.from({ length: LEDGER_KEEP_FINISHED + 1 }, (_, i) => run({ key: `o@${i}`, epochMinute: i })) };
    const store = createCronRunStore(join(dir, "cron-runs.json"), {
      now: () => SLOT, io: { read: async () => ({ status: "ok", data }), write: async (_p, d) => { data = d; } },
    });
    expect((await store.claim({ ...run(), key: undefined } as never)).claimed).toBe(true);
    expect((await store.list()).filter((r) => r.status === "success")).toHaveLength(LEDGER_KEEP_FINISHED);
  });
  test("set 开时记启用起点（已有不动），关时删掉", async () => {
    const path = join(dir, "sentinel-pilot.json");
    const deps = tickDeps("off").deps;
    const set = (mode: string, now: number) =>
      cmdSentinelPilot(["set", job.name, mode], { deps, out: () => {}, now: () => now, setMode: (j, m) => setSentinelPilotMode(j, m, path) });
    const marker = sincePath(deps.reportsDir, job);
    await set("observe", SLOT);
    expect(readFileSync(marker, "utf8")).toBe(DAY);
    await set("on", SLOT + 48 * 3_600_000);
    expect(readFileSync(marker, "utf8")).toBe(DAY);
    await set("off", SLOT + 72 * 3_600_000);
    expect(existsSync(marker)).toBe(false);
  });
});
