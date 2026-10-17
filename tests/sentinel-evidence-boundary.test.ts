import { describe, expect, test } from "bun:test";
import { collectRunEvidence } from "../src/lib/sentinel-pilot-evidence.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMutatingTool } from "../src/lib/autopilot-tools.js";
import { highRiskRecoveryKey } from "../src/lib/recovery-key-class.js";
import { recoveryPolicy, type ObservedAction, type RecoveryMode, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { isReadOnlySentinelSsh } from "../src/lib/sentinel-pilot-ssh.js";
import { testChildEnv } from "./test-env.js";

const start = Date.parse("2026-10-15T12:00:00Z");
const window = { from: start, to: start + 10_000, resultTo: start + 70_000 };
const line = (type: string, at: number, content: unknown, extra = {}) => JSON.stringify({
  type, timestamp: new Date(start + at).toISOString(), message: { content }, ...extra,
});

describe("grace turn boundaries", () => {
  for (const prompt of [
    "human", "another scheduled task", '<channel is_agent="true">agent prompt</channel>',
    '<channel is_agent="false">[button:go]</channel>', [{ type: "text", text: "new turn" }],
    [{ type: "image", source: { type: "base64", data: "example" } }],
  ]) test(`seals the old result at ${JSON.stringify(prompt)}`, () => {
    const lines = [say(9000, "异常"), line("user", 10_001, prompt), say(11_000)];
    expect(collect(lines).result?.verdict).toBe("异常");
    expect(collect([line("user", 10_001, prompt), say(11_000)]).result).toBeNull();
  });
  test("meta, tool results and empty records do not start a new prompt", () => {
    const lines = [
      line("user", 10_001, "injected metadata", { isMeta: true }),
      line("user", 10_002, [{ type: "tool_result", tool_use_id: "t", content: "done" }]),
      line("user", 10_003, ""), say(14_200),
    ];
    expect(collect(lines).result?.verdict).toBe("正常");
  });
  test("the audit window stays inclusive and ignores all grace tools, humans, buttons and quota text", () => {
    const lines = [
      tool(10_000, "Read", {}), say(10_000, "异常"),
      tool(10_001, "Write", {}), tool(10_002, "AskUserQuestion", {}),
      line("user", 10_003, "human"),
      tool(10_004, "mcp__claudestra__reply", { text: "哨兵结果:正常", components: [{}] }),
      line("assistant", 10_005, [{ type: "text", text: "You've hit your limit" }]),
    ];
    expect(collect(lines)).toMatchObject({ result: { verdict: "异常" }, evidence: {
      tools: 1, mutating: 0, buttonsSent: 0, questionOpen: false, humanInterleaved: false,
    } });
    expect(collect(lines).evidence.rateLimitText).toBeUndefined();
    expect(collect([line("user", 10_000, "human"), say(10_001)]).evidence.humanInterleaved).toBe(true);
  });
  test("late replies, inclusive result deadline, exclusive dispatch deadline and pre-window rows", () => {
    expect(collect([say(-1, "异常"), say(70_000)]).result?.verdict).toBe("正常");
    expect(collect([say(70_001)]).result).toBeNull();
    const opts = { boundary: { policy: policy("on") } };
    expect(collectRunEvidence([say(12_000)], { ...window, nextDispatchAt: start + 12_000 }, opts).result).toBeNull();
    expect(collectRunEvidence([say(11_999)], { ...window, nextDispatchAt: start + 12_000 }, opts).result?.verdict).toBe("正常");
    expect(collectRunEvidence([say(10_001)], { from: start, to: window.to }, opts).result).toBeNull();
    expect(collect([line("user", -1, "old task"), say(12_000)]).result?.verdict).toBe("正常");
  });
  test("a fresh grace prompt stops subsequent fragments of the same assistant message id", () => {
    const fragment = (at: number, verdict: string) => JSON.stringify({ type: "assistant", timestamp: new Date(start + at).toISOString(),
      message: { id: "same", content: [{ type: "text", text: `哨兵结果:${verdict}` }] } });
    expect(collect([fragment(9000, "异常"), line("user", 10_001, "next"), fragment(11_000, "正常")]).result?.verdict).toBe("异常");
  });
});

describe("safe redirect evidence only", () => {
  const safe = [
    "ssh host 'cat /sample 2>/dev/null'", "ssh host 'cat /sample >/dev/null 2>&1'",
    "ssh host 'cat /sample 1>&2 2>>/dev/null'", "ssh host 'cat /sample &>/dev/null'",
    "ssh host 'cat /sample &>>/dev/null'", "ssh host 'cat /sample >|/dev/null'",
    "ssh host 'cat /sample 12>&1'", "ssh host 'cat /sample 2>&1 1>/dev/null'",
    "ssh host 'cat /sample 2>&1>/dev/null'", "ssh host 'cat /sample >/dev/null 2>&1>&2'",
    "ssh host 'cat /sample 2>/dev/null | tail -n 2'", "ssh host 'uptime; df -h 2>/dev/null'",
    "ssh host 'cat /sample 2>/dev/null && uptime'", "ssh host 'cat /sample 2>/dev/null || uptime'",
    "ssh host 'cat /sample 2>/dev/null\nuptime'", "ssh host 'cat < /sample 2>/dev/null'",
    'ssh host \'cat /sample 2>"/dev/null"\'', "ssh host 'cat /sample' 2>/dev/null 1>&2",
    "2>/dev/null ssh host 'cat /sample'", "ssh host cat /sample 2>/dev/null",
    "ssh -nT -oBatchMode=yes host 'cat /sample 2>/dev/null'",
  ];
  for (const command of safe) test(`safe: ${command}`, () => {
    expect(isReadOnlySentinelSsh(command, true)).toBe(true);
    for (const name of ["Bash", "bash", "exec_command", "shell"]) {
      expect(collect([tool(9000, name, { cmd: command })]).evidence.mutating).toBe(0);
      expect(isMutatingTool(name, JSON.stringify({ cmd: command }))).toBe(true);
    }
    expect(collect([tool(9000, "Write", { command })]).evidence.mutating).toBe(1);
  });
  const unsafe = [
    "ssh host 'cat /sample > file'", "ssh host 'cat /sample >> file 2>&1'",
    "ssh host 'cat /sample 3>file 1>&3'", "ssh host 'cat /sample 3<>file 1>&3'",
    "ssh host 'cat /sample >$DEST'", 'ssh host \'cat /sample >"$DEST"\'',
    "ssh host 'cat /sample >${DEST:-/dev/null}'", "ssh host 'cat /sample >$(echo /dev/null)'",
    "ssh host 'cat /sample >`echo /dev/null`'", "ssh host 'cat /sample > /dev/nul?'",
    "ssh host 'cat /sample > /dev/{null,stdout}'", "ssh host 'cat /sample > /dev/null$SUFFIX'",
    String.raw`ssh host 'cat /sample >"/dev/nu\ll"'`,
    String.raw`ssh host 'uptime' 2>"/dev/nu\ll"`,
    "ssh host 'cat /sample {fd}>/dev/null'", "ssh host 'cat /sample {fd}>&1'",
    "ssh host 'cat /sample >/dev/null\r'", "ssh host 'uptime' >/dev/null\r",
    "ssh host 'cat /sample > >(cat)'", "ssh host 'cat <(rm file)'",
    "ssh host 'cat /sample 2>&file'", "ssh host 'cat /sample 2>&$FD'",
    "ssh host 'cat /sample 2>&1foo'", "ssh host 'cat /sample 2>&-'",
    "ssh host 'cat /sample 2>&1>file'", "ssh host 'cat /sample 2>&1&&rm file'",
    "ssh host 'cat /sample >/dev/stdout'", "ssh host 'cat /sample >/dev/stderr'",
    "ssh host 'cat /sample >/dev/null; rm file'", "ssh host 'cat /sample >/dev/null\nrm file'",
    "ssh host 'cat /sample >/dev/null | tee file'", "ssh host 'rm file >/dev/null'",
    "ssh host 'cat /sample >/dev/null' >file", "ssh host 'uptime' 3>file 2>&3",
    "ssh host 'uptime' 2>/dev/null && rm file", "ssh host 'uptime' 2>/dev/null; rm file",
    "ssh host 'uptime' 2>/dev/null\nrm file", "ssh host 'uptime' 2>/dev/null | cat",
    "ssh -L8080:dest:80 host 'uptime 2>/dev/null'", "ssh -R8080:dest:80 host uptime 2>/dev/null",
    "ssh -D8080 host uptime 2>/dev/null", "ssh -oProxyCommand=uptime host 'uptime 2>/dev/null'",
    "ssh -oRemoteCommand=uptime host 'uptime 2>/dev/null'", "ssh $HOST uptime 2>/dev/null",
    "ssh host 'cat /sample 2>'", "ssh host 'cat /sample 2> > /dev/null'",
    "ssh host 'cat /sample >/dev/null &&'", "ssh host 'cat /sample >/dev/null || | uptime'",
    "ssh host 'cat /sample >/dev/null", "ssh host 'cat /sample >/dev/null &'",
  ];
  for (const command of unsafe) test(`unsafe: ${command}`, () => {
    expect(isReadOnlySentinelSsh(command, true)).toBe(false);
    expect(collect([tool(9000, "Bash", { command })]).evidence.mutating).toBe(1);
  });
});

describe("recovery modes", () => {
  const lines = [tool(8000, "Bash", { command: "ssh host 'cat /sample 2>/dev/null'" }),
    say(9000, "异常"), line("user", 10_001, "next"), say(11_000)];
  test("observe returns exactly off's baseline and records just the difference without transcript text", () => {
    const actions: ObservedAction[] = [];
    const before = collect(lines, "off");
    const observed = collectRunEvidence(lines, window, { boundary: { policy: policy("observe"), observe: (a) => actions.push(a) } });
    expect(observed).toEqual(before);
    expect(observed).toMatchObject({ result: { verdict: "正常" }, evidence: { mutating: 1 } });
    expect(actions).toHaveLength(1);
    expect(actions[0].data).toMatchObject({ before: { verdict: "正常", mutating: 1 }, after: { verdict: "异常", mutating: 0 } });
    expect(JSON.stringify(actions)).not.toContain("/sample");
    expect(JSON.stringify(actions)).not.toContain("example");
    for (const mode of ["off", "on", "observe"] as const) {
      const samples: ObservedAction[] = [];
      collectRunEvidence([say(9000)], window, { boundary: { policy: policy(mode), observe: (a) => samples.push(a) } });
      expect(samples).toEqual([]);
    }
  });
  test("default is a high-risk observe key; live file changes take effect on the next collection", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentbound-policy-"));
    const path = join(dir, "policy.json");
    const filePolicy: RecoveryPolicyPort = (p, k) => recoveryPolicy(p, k, path);
    const samples: ObservedAction[] = [];
    const opts = { boundary: { policy: filePolicy, observe: (a: ObservedAction) => samples.push(a) } };
    try {
      expect(highRiskRecoveryKey("sentinelEvidenceBoundary")).toBe(true);
      expect(filePolicy("claude-orchestrator", "sentinelEvidenceBoundary").mode).toBe("observe");
      for (const mode of ["observe", "on", "off", "on", "observe"] as const) {
        writeFileSync(path, JSON.stringify({ projects: { "claude-orchestrator": { keys: { sentinelEvidenceBoundary: mode } } } }));
        const ev = collectRunEvidence(lines, window, opts);
        expect(ev.result?.verdict).toBe(mode === "on" ? "异常" : "正常");
        expect(ev.evidence.mutating).toBe(mode === "on" ? 0 : 1);
      }
      expect(samples).toHaveLength(2);
      writeFileSync(path, "broken");
      expect(collectRunEvidence(lines, window, opts)).toEqual(collect(lines, "off"));
      writeFileSync(path, JSON.stringify({ projects: { "claude-orchestrator": { mode: "on", keys: { sentinelEvidenceBoundary: "off" } } } }));
      expect(collectRunEvidence(lines, window, opts)).toEqual(collect(lines, "off"));
      writeFileSync(path, JSON.stringify({ projects: { "claude-orchestrator": { mode: "off", keys: { sentinelEvidenceBoundary: "on" } } } }));
      expect(collectRunEvidence(lines, window, opts)).toEqual(collect(lines, "on"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("real report/tick entry: all nine upstream/boundary combinations and deduplicated default observation", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentbound-integration-"));
    const lib = join(import.meta.dir, "../src/lib");
    const script = `
      import { strict as assert } from "node:assert";
      import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
      import { join } from "node:path";
      import { collectRunEvidence } from ${JSON.stringify(join(lib, "sentinel-pilot-evidence.ts"))};
      import { sentinelPilotTick, sincePath } from ${JSON.stringify(join(lib, "sentinel-pilot-tick.ts"))};
      import { localDate, reportFileName } from ${JSON.stringify(join(lib, "sentinel-pilot.ts"))};
      import { recoveryPolicy, RECOVERY_POLICY_PATH } from ${JSON.stringify(join(lib, "recovery-policy.ts"))};
      import { openLedger, listEvents } from ${JSON.stringify(join(lib, "ledger-store.ts"))};
      const lines = ${JSON.stringify(lines)}, window = ${JSON.stringify(window)};
      assert.equal(recoveryPolicy("claude-orchestrator", "sentinelEvidenceBoundary").mode, "observe");
      for (let n = 0; n < 2; n++) assert.equal(collectRunEvidence(lines, window).result.verdict, "正常");
      const samples = () => listEvents(openLedger(), {}).filter(e => e.data.mechanism === "sentinelEvidenceBoundary");
      assert.equal(samples().length, 1);
      const slot = new Date(2026, 9, 15, 12).getTime(), day = localDate(new Date(slot));
      const iso = t => new Date(t).toISOString();
      const fixture = lines.map(l => {
        const r = JSON.parse(l); r.timestamp = iso(slot + Date.parse(r.timestamp) - window.from); return JSON.stringify(r);
      });
      const job = { id: "pilot", name: "pilot", schedule: "0 12 * * *", prompt: "check", dir: "-",
        targetAgent: "pilot", enabled: true, createdAt: iso(slot), reportChannelId: "fixture" };
      const run = { key: "pilot@" + slot / 60000, jobId: "pilot", jobName: "pilot", epochMinute: slot / 60000,
        historyId: "h", owner: "o", startedAt: iso(slot), dispatchAttemptedAt: iso(slot), finishedAt: iso(slot + 10000),
        deadlineAt: iso(slot + 10000), status: "success", targetSessionId: "session" };
      let n = 0;
      for (const upstream of ["off", "observe", "on"]) for (const boundary of ["off", "observe", "on"]) {
        writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { "claude-orchestrator": {
          keys: { sentinelEvidenceBoundary: boundary } } } }));
        const reportsDir = join(${JSON.stringify(dir)}, upstream + "-" + boundary);
        mkdirSync(reportsDir); writeFileSync(sincePath(reportsDir, job), day);
        let reads = 0, sent = 0;
        const deps = { reportsDir, loadJobs: async () => [job], listRuns: async () => [run], mode: () => upstream,
          readSession: async () => { reads++; return { lines: fixture }; },
          notify: async () => { sent++; return true; }, log() {}, error(e) { throw new Error(e); } };
        await sentinelPilotTick(new Date(slot + (61 + n++) * 60000), deps);
        const report = join(reportsDir, reportFileName(job, day));
        assert.equal(reads, upstream === "off" ? 0 : 1);
        assert.equal(existsSync(report), upstream !== "off");
        assert.equal(sent, upstream === "on" ? 1 : 0);
        if (upstream !== "off") {
          const text = readFileSync(report, "utf8");
          assert(text.includes("## 12:00 · " + (boundary === "on" ? "异常" : "正常")), text);
          assert(text.includes(boundary === "on" ? "越界：无" : "越界：试点只读"), text);
        }
      }
      console.log(JSON.stringify({ combinations: n, observed: samples().length }));
    `;
    try {
      const result = Bun.spawnSync([process.execPath, "--eval", script], { env: testChildEnv({ CLAUDESTRA_STATE_DIR: dir }), timeout: 30_000 });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toMatchObject({ combinations: 9 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
const say = (at: number, verdict = "正常") => line("assistant", at, [{ type: "text", text: `哨兵结果:${verdict} — example` }]);
const tool = (at: number, name: string, input: unknown) => line("assistant", at, [{ type: "tool_use", id: "t", name, input }]);
const policy = (mode: RecoveryMode): RecoveryPolicyPort => () => ({ mode, source: "config", manualAfterMs: null });
const collect = (lines: string[], mode: RecoveryMode = "on") => collectRunEvidence(lines, window, { boundary: { policy: policy(mode) } });

describe("SENTBOUND1 defect reproductions", () => {
  test("grace-turn-1: a fresh prompt cannot replace the original abnormal result", () => {
    const ev = collect([say(9000, "异常"), line("user", 10_001, "another task"), say(11_000)]);
    expect(ev.result?.verdict).toBe("异常");
    expect(ev.evidence.humanInterleaved).toBe(false);
  });
  test("ssh-devnull-2: a literal remote null sink and numeric fd copy are read-only evidence", () => {
    const ev = collect([tool(9000, "Bash", { command: "ssh host 'cat /sample 2>/dev/null 1>&2'" })]);
    expect(ev.evidence).toMatchObject({ tools: 1, mutating: 0 });
  });
});
