import { describe, expect, test } from "bun:test";
import type { CronJob } from "../src/lib/cron-job.js";
import type { CronRunRecord } from "../src/lib/cron-run-state.js";
import { collectRunEvidence } from "../src/lib/sentinel-pilot-evidence.js";
import { buildDayReport } from "../src/lib/sentinel-pilot-tick.js";

const start = new Date(2026, 9, 15, 23, 59).getTime();
const finish = start + 10_000;
const iso = (ms: number) => new Date(ms).toISOString();
const job: CronJob = {
  id: "pilot", name: "pilot", schedule: "59 23 * * *", prompt: "check", dir: "-", enabled: true, createdAt: "x", targetAgent: "pilot",
};
const run = (over: Partial<CronRunRecord> = {}): CronRunRecord => ({
  key: `pilot@${start / 60_000}`, jobId: job.id, jobName: job.name, epochMinute: start / 60_000,
  historyId: "h", owner: "o", startedAt: iso(start), dispatchAttemptedAt: iso(start),
  finishedAt: iso(finish), deadlineAt: iso(finish), status: "success", targetSessionId: "session", ...over,
});
const assistant = (at: number, content: unknown[]) => JSON.stringify({ type: "assistant", timestamp: iso(at), message: { content } });
const say = (at: number, text = "哨兵结果:正常 — ok") => assistant(at, [{ type: "text", text }]);
const tool = (at: number, name: string, input: unknown) => assistant(at, [{ type: "tool_use", id: "t", name, input }]);
async function verdict(lines: string[], runs = [run()]) {
  const report = await buildDayReport(job, "2026-10-15", runs, async () => ({ lines }), "observe", finish + 120_000);
  return report.verdicts[0];
}

describe("结果行宽限回归", () => {
  test("晚 4.2 秒已验证，晚 61 秒仍未验证，60 秒边界包含", async () => {
    expect((await verdict([say(finish + 4200)])).status).toBe("normal");
    expect((await verdict([say(finish + 61_000)])).status).toBe("unverified");
    expect((await verdict([say(finish + 60_000)])).status).toBe("normal");
  });
  test("宽限不计工具、按钮、提问、人工回合或额度证据；reply 正文可以提供结果", async () => {
    const lines = [
      tool(finish, "Read", { file_path: "/x" }), tool(finish + 1, "Write", { file_path: "/x" }),
      tool(finish + 2, "AskUserQuestion", {}),
      JSON.stringify({ type: "user", timestamp: iso(finish + 3), message: { content: "human" } }),
      say(finish + 4, "You've hit your limit"),
      tool(finish + 4200, "mcp__claudestra__reply", { text: "哨兵结果:正常 — ok", components: [{}] }),
    ];
    const v = await verdict(lines);
    expect(v.status).toBe("normal");
    expect(v.ev?.evidence).toMatchObject({ tools: 1, mutating: 0, buttonsSent: 0, questionOpen: false, humanInterleaved: false });
    expect(v.ev?.evidence.rateLimitText).toBeUndefined();
  });
  test("无 finishedAt 不加宽限", async () => {
    expect((await verdict([say(finish + 1)], [run({ finishedAt: undefined })])).status).toBe("unverified");
    expect((await verdict([say(finish)], [run({ finishedAt: undefined })])).status).toBe("normal");
  });
  test("跨日报日期且乱序的下一次同任务派发封顶，边界归下一次；其他任务不截断", async () => {
    const next = run({ key: "pilot@next", epochMinute: start / 60_000 + 1, dispatchAttemptedAt: iso(finish + 50_000) });
    const other = run({ jobId: "other", dispatchAttemptedAt: iso(finish + 1000) });
    expect((await verdict([say(finish + 49_999)], [next, other, run()])).status).toBe("normal");
    expect((await verdict([say(finish + 50_000)], [next, other, run()])).status).toBe("unverified");
    expect((await verdict([say(finish + 55_000)], [run(), next])).status).toBe("unverified");
  });
  test("宽限仍只取最后一条回复；纯工具调用不抹掉结果", async () => {
    expect((await verdict([say(finish + 1), say(finish + 2, "撤回")])).status).toBe("unverified");
    expect((await verdict([say(finish + 1), tool(finish + 2, "Write", {})])).status).toBe("normal");
  });
});

describe("ssh 只读证据回归", () => {
  const reads = [
    "ssh host 'tail -n 50 /var/log/x.log'", "ssh -p 22 host uptime", "ssh -p22 -nT host 'uptime; df -h'",
    "ssh -o BatchMode=yes -oConnectTimeout=10 host 'cat /x | tail -n 5'", "ssh host tail -n 50 /var/log/x.log",
  ];
  const writes = [
    "ssh host 'rm -f x'", "ssh -L 8080:a:80 host", "ssh -R8080:a:80 host uptime", "ssh -D 8080 host uptime",
    "ssh -nL8080:a:80 host uptime", "ssh -o ProxyCommand=uptime host uptime", "ssh -oProxyCommand='rm x' host uptime",
    "ssh -o LocalForward=8080:a:80 host uptime", "scp host:x x", "rsync host:x x", "ssh host 'echo a > f'",
    "ssh host 'cat /x | tee f'", "ssh host 'uptime; rm x'", "ssh host 'uptime && rm x'",
    "ssh host 'echo $(rm x)'", "ssh host \"echo $(rm x)\"", "ssh host 'echo `rm x`'",
    "ssh host 'sh -c \"rm x\"'", "ssh host uptime > f", "ssh host uptime; rm x", "ssh host uptime && rm x",
    "ssh -F config host uptime", "ssh -E log host uptime", "ssh -o PermitLocalCommand=yes host uptime",
    "ssh -o RemoteCommand='rm x' host uptime", "ssh host", "ssh host 'uptime", "ssh $HOST uptime",
  ];
  for (const command of reads) test(`只读：${command}`, () => {
    const ev = collectRunEvidence([tool(start + 1, "Bash", { command })], { from: start, to: finish });
    expect(ev.evidence).toMatchObject({ tools: 1, mutating: 0 });
  });
  for (const command of writes) test(`仍越界：${command}`, () => {
    const ev = collectRunEvidence([tool(start + 1, "Bash", { command })], { from: start, to: finish });
    expect(ev.evidence).toMatchObject({ tools: 1, mutating: 1 });
  });
  test("Codex / Pi 的 shell 名也只在试点里应用；非 shell 工具不能伪装", () => {
    for (const name of ["exec_command", "shell", "bash"]) {
      expect(collectRunEvidence([tool(start + 1, name, { cmd: "ssh host uptime" })], { from: start, to: finish }).evidence.mutating).toBe(0);
    }
    expect(collectRunEvidence([tool(start + 1, "Write", { command: "ssh host uptime" })], { from: start, to: finish }).evidence.mutating).toBe(1);
  });
});
