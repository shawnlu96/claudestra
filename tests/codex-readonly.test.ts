/**
 * agents-CODEXRO1：只读档的校验与可见性。
 * - 验收线 4：Claude Code / Pi 用 `create --mode readOnly` 报错，registry 不写（子进程跑真 manager，临时 HOME / 状态目录）；
 * - 验收线 6：GET agents 的行带 readOnly、`manager list` 的行标「只读」、网页角标中英两套（英文无中文残留）；
 * - resume 沿用旧条目的只读、whoami 报档位。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  isAllowedMode, markReadOnlyRows, readOnlyCodexAgents, readOnlyRuntimeError, registryPermissionMode, resumePermissionMode,
} from "../src/lib/codex-readonly.js";
import { isKnownPermissionMode } from "../src/lib/claude-launch.js";
import { permissionView, whoamiTool } from "../src/lib/whoami-tool.js";
import { REPO_ROOT } from "../src/lib/repo-root.js";
import { testChildEnv } from "./test-env.ts";

const REG = {
  agents: {
    "agent-ro": { runtime: "codex", permissionMode: "readOnly", status: "active" },
    "agent-rw": { runtime: "codex", permissionMode: "bypassPermissions", status: "active" },
    "agent-cc": { runtime: "claude-code", permissionMode: "readOnly", status: "active" }, // 手改出来的脏数据：不是 Codex 不标
  },
};

function withTemp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "codexro-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("档位校验", () => {
  test("readOnly 只给 Codex；其它档位不管", () => {
    expect(readOnlyRuntimeError("readOnly", "codex")).toBeNull();
    expect(readOnlyRuntimeError("readOnly", "claude-code")).toContain("只支持 Codex");
    expect(readOnlyRuntimeError(" readOnly ", "pi")).toContain("只支持 Codex");
    expect(readOnlyRuntimeError("bypassPermissions", "pi")).toBeNull();
    expect(readOnlyRuntimeError(undefined, "claude-code")).toBeNull();
  });

  test("create / resume 的白名单：Claude 五档照旧，readOnly 只在 Codex 放行", () => {
    expect(isAllowedMode("readOnly", "codex", isKnownPermissionMode)).toBe(true);
    expect(isAllowedMode("readOnly", "claude-code", isKnownPermissionMode)).toBe(false);
    expect(isAllowedMode("plan", "claude-code", isKnownPermissionMode)).toBe(true);
    expect(isAllowedMode("nonsense", "codex", isKnownPermissionMode)).toBe(false);
  });

  test("resume：旧条目只读时没给 --mode 就沿用、显式换档就拒；旧条目不是只读照旧用给的", () => {
    expect(resumePermissionMode(undefined, { permissionMode: "readOnly" })).toEqual({ mode: "readOnly" });
    expect(resumePermissionMode("", { permissionMode: "readOnly" })).toEqual({ mode: "readOnly" });
    expect(resumePermissionMode(undefined, { permissionMode: "bypassPermissions" })).toEqual({ mode: undefined });
    expect(resumePermissionMode(undefined, undefined)).toEqual({ mode: undefined });
    expect(resumePermissionMode("bypassPermissions", { permissionMode: "readOnly" })).toEqual({ error: expect.stringContaining("只读 agent 不能换档，要换就删了重建") });
  });
});

describe("registry", () => {
  test("按 agent 名读档位（带不带 agent- 前缀都认）；缺文件 / 坏文件 = 读不到", () => withTemp((dir) => {
    const p = join(dir, "registry.json");
    expect(registryPermissionMode("ro", p)).toBeUndefined();
    writeFileSync(p, JSON.stringify(REG));
    expect(registryPermissionMode("ro", p)).toBe("readOnly");
    expect(registryPermissionMode("agent-ro", p)).toBe("readOnly");
    expect(registryPermissionMode("rw", p)).toBe("bypassPermissions");
    expect(registryPermissionMode("nobody", p)).toBeUndefined();
    writeFileSync(p, "{broken");
    expect(registryPermissionMode("ro", p)).toBeUndefined();
  }));

  test("只读 Codex 名单只收 runtime=codex 的", () => withTemp((dir) => {
    const p = join(dir, "registry.json");
    writeFileSync(p, JSON.stringify(REG));
    expect([...readOnlyCodexAgents(p)]).toEqual(["agent-ro"]);
  }));
});

describe("[验收线 6] 列表", () => {
  test("manager list 的行：只读 Codex 标「只读」，其它行不动", () => {
    const rows: Record<string, unknown>[] = [{ name: "agent-ro" }, { name: "agent-rw" }, { name: "agent-cc" }, { name: "master" }];
    markReadOnlyRows(rows, REG.agents);
    expect(rows[0]).toEqual({ name: "agent-ro", readOnly: true, mode: "只读" });
    expect(rows.slice(1)).toEqual([{ name: "agent-rw" }, { name: "agent-cc" }, { name: "master" }]);
  });

  test("GET /api/v1/agents：只读行带 readOnly:true，其它行没有（子进程，临时状态目录里的真 registry.json）", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexro-list-"));
    try {
      const state = join(root, "state");
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, "registry.json"), JSON.stringify(REG));
      const script = `
        import { handleAgentsList } from "./src/bridge/agents-list-route.ts";
        const principal = { id: "token:t", role: "owner", name: "owner", agents: ["*"], createdAt: "" };
        const rows = ["agent-ro", "agent-rw"].map((name) => ({ name, status: "stopped", idle: true, cwd: "/w", created: "" }));
        const tails = { resolve: () => null, read: async () => null, now: () => 0, warn: () => {} };
        const res = await handleAgentsList(new URL("http://x/api/v1/agents"), principal, { runManager: async () => ({ agents: rows }), clients: new Map(), controlChannelId: "", tails });
        console.log(JSON.stringify((await res.json()).agents.map((a) => ({ name: a.name, readOnly: a.readOnly ?? null }))));
      `;
      const p = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], {
        cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe",
        env: testChildEnv({ HOME: join(root, "home"), CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(root, "run"), TMPDIR: root }),
      });
      expect(p.exitCode).toBe(0);
      const out = p.stdout.toString().trim().split("\n").at(-1)!;
      expect(JSON.parse(out)).toEqual([{ name: "agent-ro", readOnly: true }, { name: "agent-rw", readOnly: null }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  /** 角标在子进程里 SSR（同 web-collab-team-work-merge.test.ts），React 不进根测试进程 */
  function renderBadge(lang: "zh" | "en"): string {
    const script = `
      import { createElement } from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { RuntimeStatusIcon } from './features/chat/components/status-dot.tsx';
      import { ReadOnlyBadge } from './features/chat/components/readonly-badge.tsx';
      const a = { name: 'ro', displayName: 'ro', purpose: '', cwd: '', status: 'active', runtime: 'codex', readOnly: true };
      console.log(renderToStaticMarkup(createElement(RuntimeStatusIcon, { a })));
      console.log(renderToStaticMarkup(createElement(RuntimeStatusIcon, { a: { ...a, readOnly: false } })));
      console.log(renderToStaticMarkup(createElement(ReadOnlyBadge, { lang: '${lang}' })));
    `;
    const p = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], { cwd: resolve(import.meta.dir, "../web"), env: testChildEnv(), stdout: "pipe", stderr: "pipe" });
    expect(p.stderr.toString()).toBe("");
    expect(p.exitCode).toBe(0);
    return p.stdout.toString();
  }

  test("[验收线 6] 网页：只读行的运行时图标旁有锁，非只读没有；中英文案各一套，英文没有中文残留", () => {
    const [withLock, without, zh] = renderBadge("zh").trim().split("\n");
    expect(withLock).toContain("data-readonly-badge");
    expect(withLock).toContain("只读：不能改文件，不能跑写入命令");
    expect(without).not.toContain("data-readonly-badge");
    expect(zh).toContain('title="只读：不能改文件，不能跑写入命令"');
    const en = renderBadge("en").trim().split("\n")[2]!;
    expect(en).toContain(`title="Read-only: can${"&#x27;"}t modify files or run write commands"`);
    expect(/[㐀-鿿]/.test(en)).toBe(false);
    expect(en).toContain("<svg"); // 图标库同款描线图标，不是 emoji
  });
});

describe("whoami 报档位", () => {
  const lookup = (a: string) => ({ "agent-ro": "readOnly", "agent-rw": "bypassPermissions" } as Record<string, string>)[a];

  test("registry 与启动时带进来的变量任一边是只读就报只读", () => {
    expect(permissionView("agent-ro", {}, lookup)).toEqual({ permissionMode: "readOnly", readOnly: true });
    expect(permissionView("agent-rw", { CLAUDESTRA_PERMISSION_MODE: "readOnly" }, lookup)).toEqual({ permissionMode: "readOnly", readOnly: true });
    expect(permissionView("agent-rw", {}, lookup)).toEqual({ permissionMode: "bypassPermissions", readOnly: false });
    expect(permissionView(undefined, {}, lookup)).toEqual({ permissionMode: "bypassPermissions", readOnly: false });
  });

  test("whoami 工具输出：bridge 的身份字段原样 + 档位", async () => {
    const r = await whoamiTool(async () => ({ agent: "agent-ro", verified: true }), {}, lookup);
    expect(JSON.parse(r.content[0]!.text)).toEqual({ agent: "agent-ro", verified: true, permissionMode: "readOnly", readOnly: true });
    const anon = await whoamiTool(async () => null, { CLAUDESTRA_AGENT: "agent-ro" }, lookup);
    expect(JSON.parse(anon.content[0]!.text)).toMatchObject({ readOnly: true });
  });
});

describe("[验收线 4] create --mode readOnly", () => {
  for (const runtime of ["claude-code", "pi"]) {
    test(`${runtime}：报错说明只支持 Codex，registry 不写`, () => {
      const root = mkdtempSync(join(tmpdir(), "codexro-create-"));
      try {
        const state = join(root, "state");
        const work = join(root, "work");
        mkdirSync(work, { recursive: true });
        const p = Bun.spawnSync([process.execPath, "--no-env-file", "src/manager.ts", "create", `ro-${runtime}`, work, "--runtime", runtime, "--mode", "readOnly"], {
          cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe",
          env: testChildEnv({ HOME: join(root, "home"), CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(root, "run"), TMPDIR: root }),
        });
        const out = JSON.parse(p.stdout.toString().trim().split("\n").at(-1)!);
        expect(out.ok).toBe(false);
        expect(out.error).toContain("readOnly 只支持 Codex");
        const reg = join(state, "registry.json");
        expect(existsSync(reg) ? readFileSync(reg, "utf8") : "").not.toContain(`ro-${runtime}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 60_000);
  }
});

describe("manager mode：只读 agent 不能换档", () => {
  test("子进程真跑 manager mode：只读条目改成 bypassPermissions 被拒、registry 不变；非只读条目照旧能改", () => {
    const root = mkdtempSync(join(tmpdir(), "codexro-mode-"));
    try {
      const state = join(root, "state");
      mkdirSync(state, { recursive: true });
      const reg = join(state, "registry.json");
      writeFileSync(reg, JSON.stringify(REG));
      const run = (agent: string, mode: string) => {
        const p = Bun.spawnSync([process.execPath, "--no-env-file", "src/manager.ts", "mode", agent, mode], {
          cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe",
          env: testChildEnv({ HOME: join(root, "home"), CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(root, "run"), TMPDIR: root }),
        });
        return JSON.parse(p.stdout.toString().trim().split("\n").at(-1)!) as { ok: boolean; error?: string };
      };
      const denied = run("agent-ro", "bypassPermissions");
      expect(denied.ok).toBe(false);
      expect(denied.error).toContain("只读 agent 不能换档，要换就删了重建");
      expect(JSON.parse(readFileSync(reg, "utf8")).agents["agent-ro"].permissionMode).toBe("readOnly");
      expect(run("agent-rw", "plan").ok).toBe(true);
      expect(JSON.parse(readFileSync(reg, "utf8")).agents["agent-rw"].permissionMode).toBe("plan");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
