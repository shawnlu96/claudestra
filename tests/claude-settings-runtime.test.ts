/**
 * web-1：Codex（以及任何非 Claude Code）agent 不该拿到 Claude Code 的模型/effort 切换。
 *
 * 两处 bridge 行为：
 *   1. GET /api/v1/agents 如实透传 registry.runtime（以前只认 pi，Codex 被改写成
 *      claude-code ⇒ 网页顶栏据此挂上 CC 面板）；
 *   2. POST /api/v1/agents/:name/claude-settings 对非 CC agent 回 400（照 pi-settings），
 *      而不是被 CC 的空闲判据判成忙、恒回 409「回合进行中」。
 *
 * 复用 api-route-parity.runner.ts 的沙箱（tests/api-runner-harness.ts）：不碰真实 registry，也不碰 master.sock。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runnerHome, type RunnerHome, type RunnerResult } from "./api-runner-harness";
import { nonClaudeRuntimeError } from "../src/lib/claude-settings-runtime";
import type { RegistryAgent } from "../src/lib/registry";

type Spec = { name: string; method: string; path: string; token?: "full"; body?: string };

const REGISTRY = {
  agents: {
    "agent-cx": { channelId: "api:cx", status: "stopped", cwd: "/tmp/x", runtime: "codex" },
    "agent-pp": { channelId: "api:pp", status: "stopped", cwd: "/tmp/x", runtime: "pi" },
    "agent-cc": { channelId: "api:cc", status: "stopped", cwd: "/tmp/x", runtime: "claude-code" },
    "agent-old": { channelId: "api:old", status: "stopped", cwd: "/tmp/x" }, // 历史数据：无 runtime 字段
  },
};

let sandbox: RunnerHome | null = null;
let results: RunnerResult[] = [];

const settings = (agent: string): Spec => ({
  name: `settings ${agent}`,
  method: "POST",
  path: `/api/v1/agents/${agent}/claude-settings`,
  token: "full",
  body: JSON.stringify({ effort: "high" }),
});
const byName = (n: string) => results.find((x) => x.name === n)!;

beforeAll(() => {
  sandbox = runnerHome("claude-settings-rt-", REGISTRY);
  results = sandbox.run([
    { name: "list", method: "GET", path: "/api/v1/agents", token: "full" },
    settings("cx"),
    settings("agent-cx"),
    settings("pp"),
    settings("cc"),
    settings("old"),
  ] satisfies Spec[]);
}, 60_000);

afterAll(() => sandbox?.cleanup());

describe("nonClaudeRuntimeError（claude-settings 的 runtime 闸，纯函数）", () => {
  const regs: RegistryAgent[] = [
    { name: "agent-cx", runtime: "codex" },
    { name: "agent-pp", runtime: "pi" },
    { name: "agent-cc", runtime: "claude-code" },
    { name: "agent-old" },
    { name: "agent-typo", runtime: "no-such-runtime" },
  ];

  test("Codex：带不带 agent- 前缀都拦，错误里写明 runtime 与 registry 名", () => {
    for (const n of ["cx", "agent-cx"]) {
      const e = nonClaudeRuntimeError(n, regs);
      expect(e).toContain("runtime=codex");
      expect(e).toContain('"agent-cx"');
      expect(e).not.toContain("/pi-settings");
    }
  });

  test("Pi：拦，并指向 /pi-settings", () => {
    expect(nonClaudeRuntimeError("pp", regs)).toContain("/pi-settings");
  });

  test("Claude Code / 缺失 runtime / 未知 runtime（按 CC 处理）/ 不在 registry（master）放行", () => {
    for (const n of ["cc", "old", "typo", "master", "nobody"]) {
      expect(nonClaudeRuntimeError(n, regs)).toBeNull();
    }
  });
});

describe("GET /api/v1/agents：runtime 如实透传", () => {
  test("codex / pi 原样给出；缺失 runtime 的历史 agent 回 claude-code", () => {
    const r = byName("list");
    expect(r.status).toBe(200);
    const agents = (JSON.parse(r.body!).agents ?? []) as { name: string; runtime?: string }[];
    const rt = Object.fromEntries(agents.map((a) => [a.name, a.runtime]));
    expect(rt).toEqual({
      "agent-cx": "codex",
      "agent-pp": "pi",
      "agent-cc": "claude-code",
      "agent-old": "claude-code",
    });
  });
});

describe("POST claude-settings：只接 Claude Code agent", () => {
  test("Codex agent → 400，写明 runtime（不再是误导的 409「回合进行中」）", () => {
    for (const n of ["settings cx", "settings agent-cx"]) {
      const r = byName(n);
      expect(r.status).toBe(400);
      const j = JSON.parse(r.body!);
      expect(j.ok).toBe(false);
      expect(j.error).toContain("runtime=codex");
      expect(j.error).toContain("agent-cx");
    }
  });

  test("Pi agent → 400，并指向 /pi-settings", () => {
    const r = byName("settings pp");
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body!).error).toContain("/pi-settings");
  });

  test("Claude Code agent（显式或缺省 runtime）放行：越过 runtime 闸，走到 CC 的空闲判据", () => {
    // 假 tmux 抓屏为空 ⇒ paneLooksIdle 为假 ⇒ 409。能走到这一步 = runtime 闸没拦它
    for (const n of ["settings cc", "settings old"]) {
      const r = byName(n);
      expect(r.status).toBe(409);
      const err = JSON.parse(r.body!).error as string;
      expect(err).not.toContain("不是 Claude Code agent");
      expect(err).toContain("回合中");
    }
  });
});
