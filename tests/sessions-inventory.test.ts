import { describe, expect, test } from "bun:test";
import {
  reconcileSessions,
  doppelgangers,
  type RawClaudeSession,
  type JobStateInfo,
  type RegistryAgentLite,
} from "../src/bridge/sessions-inventory";

const HOME = "/Users/shawn";

const registry: RegistryAgentLite[] = [
  {
    name: "agent-claudestra",
    sessionId: "51fef248-6ad1-490c-8b8b-44d1d37630e4",
    cwd: "/Users/shawn/repos/claude-orchestrator",
    channelId: "1495997330061791353",
    displayName: "claudestra",
  },
  {
    name: "agent-token-analysis",
    sessionId: "9ad678cd-dad3-4968-831f-c739de4424a2",
    cwd: "/Users/shawn/repos/token-analysis",
    displayName: "token-analysis",
  },
  {
    // registry 里 cwd 用 ~ 写法的老条目
    name: "agent-tilde",
    sessionId: "aaaaaaaa-0000-0000-0000-000000000000",
    cwd: "~/repos/tilde-project",
  },
];

describe("reconcileSessions", () => {
  test("interactive 会话 sessionId 命中 registry → registeredAgent", () => {
    const raw: RawClaudeSession[] = [
      {
        pid: 74777,
        cwd: "/Users/shawn/repos/claude-orchestrator",
        kind: "interactive",
        sessionId: "51fef248-6ad1-490c-8b8b-44d1d37630e4",
        name: "claudestra",
        status: "busy",
      },
    ];
    const out = reconcileSessions(raw, new Map(), registry, HOME);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("interactive");
    expect(out[0].registeredAgent).toBe("agent-claudestra");
    expect(out[0].doppelgangerOf).toBeUndefined();
    expect(out[0].status).toBe("busy");
  });

  test("bg 会话同名但 sessionId 不同 → doppelganger(same-name)", () => {
    const raw: RawClaudeSession[] = [
      {
        pid: 72192,
        cwd: "/Users/shawn/repos/token-analysis",
        kind: "background",
        sessionId: "68115ded-909f-4a21-b1b4-a9da109673c9",
        name: "token-analysis",
        id: "68115ded",
        state: "blocked",
      },
    ];
    const out = reconcileSessions(raw, new Map(), registry, HOME);
    expect(out[0].kind).toBe("background");
    expect(out[0].registeredAgent).toBeUndefined();
    expect(out[0].doppelgangerOf).toBe("agent-token-analysis");
    expect(out[0].doppelgangerReason).toBe("same-name");
    expect(out[0].status).toBe("blocked");
    expect(out[0].bgId).toBe("68115ded");
  });

  test("bg 会话无名但 cwd 命中（含 ~ 展开）→ doppelganger(same-cwd)", () => {
    const raw: RawClaudeSession[] = [
      {
        kind: "background",
        sessionId: "bbbbbbbb-1111-1111-1111-111111111111",
        cwd: "/Users/shawn/repos/tilde-project",
        id: "bbbbbbbb",
        state: "done",
      },
    ];
    const out = reconcileSessions(raw, new Map(), registry, HOME);
    expect(out[0].doppelgangerOf).toBe("agent-tilde");
    expect(out[0].doppelgangerReason).toBe("same-cwd");
  });

  test("bg 会话 sessionId 精确命中 registry → 正式会话，不算分身", () => {
    const raw: RawClaudeSession[] = [
      {
        kind: "background",
        sessionId: "9ad678cd-dad3-4968-831f-c739de4424a2",
        cwd: "/Users/shawn/repos/token-analysis",
        name: "token-analysis",
        id: "9ad678cd",
        state: "working",
      },
    ];
    const out = reconcileSessions(raw, new Map(), registry, HOME);
    expect(out[0].registeredAgent).toBe("agent-token-analysis");
    expect(out[0].doppelgangerOf).toBeUndefined();
  });

  test("野生 bg 会话（无名、cwd 不匹配）→ 既不注册也不是分身", () => {
    const raw: RawClaudeSession[] = [
      {
        kind: "background",
        sessionId: "cccccccc-2222-2222-2222-222222222222",
        cwd: "/tmp/unrelated",
        id: "cccccccc",
        state: "working",
      },
    ];
    const out = reconcileSessions(raw, new Map(), registry, HOME);
    expect(out[0].registeredAgent).toBeUndefined();
    expect(out[0].doppelgangerOf).toBeUndefined();
  });

  test("job state 补充 intent/detail/tokens，state 兜底 status", () => {
    const jobStates = new Map<string, JobStateInfo>([
      [
        "68115ded",
        {
          state: "blocked",
          intent: "调查 xx 问题",
          detail: "卡在权限确认",
          tokens: 12345,
          updatedAt: "2026-07-09T04:00:00Z",
        },
      ],
    ]);
    const raw: RawClaudeSession[] = [
      {
        kind: "background",
        sessionId: "68115ded-909f-4a21-b1b4-a9da109673c9",
        cwd: "/Users/shawn/repos/token-analysis",
        name: "token-analysis",
        id: "68115ded",
        // 上游条目缺 state → 用 job state 兜底
      },
    ];
    const out = reconcileSessions(raw, jobStates, registry, HOME);
    expect(out[0].status).toBe("blocked");
    expect(out[0].intent).toBe("调查 xx 问题");
    expect(out[0].tokens).toBe(12345);
  });

  test("缺 sessionId 的条目被跳过；status 全缺 → unknown", () => {
    const raw: RawClaudeSession[] = [
      { kind: "interactive", pid: 1 }, // 无 sessionId → 跳过
      { kind: "interactive", sessionId: "dddddddd-3333-3333-3333-333333333333" },
    ];
    const out = reconcileSessions(raw, new Map(), registry, HOME);
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("unknown");
  });

  test("doppelgangers() 过滤快捷函数", () => {
    const raw: RawClaudeSession[] = [
      {
        kind: "interactive",
        sessionId: "51fef248-6ad1-490c-8b8b-44d1d37630e4",
        name: "claudestra",
        status: "busy",
      },
      {
        kind: "background",
        sessionId: "68115ded-909f-4a21-b1b4-a9da109673c9",
        name: "token-analysis",
        id: "68115ded",
        state: "blocked",
      },
    ];
    const out = reconcileSessions(raw, new Map(), registry, HOME);
    const dops = doppelgangers(out);
    expect(dops).toHaveLength(1);
    expect(dops[0].bgId).toBe("68115ded");
  });
});

import { claudeBinCandidates } from "../src/bridge/sessions-inventory";

describe("claudeBinCandidates", () => {
  test("登录 shell 解析出的 claude 排第一，其余候选保持原序且不重复", () => {
    expect(claudeBinCandidates("/opt/homebrew/bin/claude")).toEqual([
      "/opt/homebrew/bin/claude", "claude", "/usr/local/bin/claude",
    ]);
    expect(claudeBinCandidates("/Users/x/.npm-global/bin/claude")[0]).toBe("/Users/x/.npm-global/bin/claude");
  });

  test("解析失败 → 原候选", () => {
    expect(claudeBinCandidates(null)).toEqual(["claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]);
  });
});
