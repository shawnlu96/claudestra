/**
 * hardening-CODEXUP2：网页手动升级按异常类型分开报（审查 web-mismatch），shell 输出外发前先过 redactSecrets（shell-tail）。
 * 安装探测 / shell / 通知 / 重启全 fake；凭据夹具照 tests/usage-classify.test.ts 的脱敏用例构造。
 */
import { describe, expect, test } from "bun:test";
import { handleRuntimeUpdate, prepareCodexUpdate, type RuntimeUpdateDeps } from "../src/bridge/runtime-update";
import { codexAutoUpdateTick, type CodexAutoDeps } from "../src/lib/codex-auto-update";
import { redactShellTail, type CodexInstall } from "../src/lib/codex-update-install";
import type { Principal } from "../src/lib/principals";

const OWNER = { id: "discord:1", role: "owner", agents: ["*"], createdAt: "2026-01-01T00:00:00Z" } as Principal;
const PREFIX = "/fake/prefix-a";
const ROOT = `${PREFIX}/lib/node_modules`;
const inst = (version: string): CodexInstall => ({ version, npm: true, prefix: PREFIX, root: ROOT, path: `${ROOT}/@openai/codex/bin/codex.js` });

/** 真的 prepareCodexUpdate（安装复核在它的 afterShell 里），探测依次给出 versions（用完停在最后一个） */
function gate(versions: string[]) {
  let i = 0;
  return () => prepareCodexUpdate({
    install: async () => inst(versions[Math.min(i++, versions.length - 1)]!),
    latest: async () => "0.160.1",
    adapter: () => null,
    selected: () => "upstream",
    npmFor: (prefix: string) => ({ npm: `${prefix}/bin/npm`, binDir: `${prefix}/bin` }),
  } as never);
}

function web(prepare: RuntimeUpdateDeps["updaters"]["codex"]["prepare"], shell = { ok: true, tail: "added 1 package" }) {
  const restarts: string[] = [];
  const d: RuntimeUpdateDeps = {
    agents: async () => [{ name: "agent-c", runtime: "codex" }],
    busy: () => false,
    shell: async () => shell,
    lock: async () => ({ release: () => {} }),
    updaters: {
      pi: { label: "Pi", prepare: async () => ({ command: "pi update" }), forget: () => {} },
      codex: { label: "Codex", prepare, forget: () => {} },
    },
  };
  const post = async (restart: { ok: boolean; error?: string } = { ok: true }) => {
    const r = await handleRuntimeUpdate("/agents/c/codex-update", OWNER, async (...a: string[]) => (restarts.push(a.join(" ")), restart), d);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { post, restarts };
}

function auto(shell: { ok: boolean; tail: string }) {
  const notes: string[] = [];
  const restarts: string[] = [];
  const d: CodexAutoDeps = {
    now: () => 1_000_000_000,
    enabled: async () => true,
    installed: async () => inst("0.159.3"),
    latest: async () => "0.160.1",
    agents: async () => [{ name: "agent-a", runtime: "codex", transport: "acp", status: "active" }],
    busy: async () => [],
    lock: async () => ({ release: () => {} }),
    prepare: gate(["0.159.3"]),
    shell: async () => shell,
    restart: async (name) => (restarts.push(name), { ok: true }),
    notify: async (text) => (notes.push(text), true),
    log: () => {},
    load: () => ({}),
    save: () => {},
  };
  return { d, notes, restarts };
}

describe("网页手动升级：按异常类型分开报", () => {
  test("[验收线 1] shell 成功但版本没变：500，说升级没生效、没有重启，不提适配器和 acp-install", async () => {
    const { post, restarts } = web(gate(["0.159.3"]));
    const { status, body } = await post();
    expect(status).toBe(500);
    expect(body).toEqual({
      ok: false,
      error: "Codex 升级没生效，没有重启 agent：安装命令成功了，但实际在用的 codex 仍是 0.159.3，不是 0.160.1",
      output: "added 1 package",
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain("切换适配器失败");
    expect(text).not.toContain("acp-install");
    expect(text).not.toContain("已更新");
    expect(restarts).toEqual([]);
  });

  test("[验收线 1] 适配器对账失败（别的 afterShell 异常）：仍是原文案", async () => {
    const { post, restarts } = web(async () => ({ command: "npm i", afterShell: async () => { throw new Error("对账时 Codex 版本一直在变"); } }));
    const { status, body } = await post();
    expect(status).toBe(500);
    expect(body).toEqual({
      ok: false,
      error: "Codex 已更新，但切换适配器失败（跑一次 manager acp-install 再重启）：Error: 对账时 Codex 版本一直在变",
      output: "added 1 package",
    });
    expect(restarts).toEqual([]);
  });

  test("[验收线 1] 装上了目标版本：200，照常重启", async () => {
    const { post, restarts } = web(gate(["0.159.3", "0.160.1"]));
    expect(await post()).toEqual({ status: 200, body: { ok: true, agent: "agent-c", output: "added 1 package" } });
    expect(restarts).toEqual(["restart agent-c"]);
  });
});

describe("shell 输出外发前脱敏", () => {
  const LEAKS = ["ZYXwvutsrqponm987654", "abcdefghijklmnop123456", "bob", "hunter2pass", "npm_abcdefghijklmnopqrstuvwxyz0123456789", "/Users/carol", "~/.npm"];
  const TAIL = [
    "npm http fetch GET 401 https://bob:hunter2pass@registry.example.com/@openai%2fcodex",
    "npm verbose headers authorization: Bearer ZYXwvutsrqponm987654",
    "npm verbose 重试时带的是 Bearer abcdefghijklmnop123456 这一份",
    "npm error 令牌 npm_abcdefghijklmnopqrstuvwxyz0123456789 被拒",
    "npm error path /Users/carol/.nvm/versions/node/v22.0.0/lib/node_modules/@openai/codex",
    "npm error A complete log of this run can be found in: ~/.npm/_logs/x-debug-0.log",
  ].join("\n");
  const clean = (text: string) => {
    for (const leak of LEAKS) expect(text).not.toContain(leak);
    expect(text).toContain("authorization: Bearer [redacted]");
    expect(text).toContain("npm error path <路径>");
    expect(text).toContain("registry.example.com");
  };

  test("[验收线 2] redactShellTail：认证头、单独的 Bearer 凭据、URL 账号密码、npm_ 令牌、家目录路径都遮掉", () => {
    clean(redactShellTail(TAIL));
  });

  test("[验收线 2] 自动更新通知：失败的 shell 输出脱敏后才发", async () => {
    const { d, notes, restarts } = auto({ ok: false, tail: TAIL });
    expect((await codexAutoUpdateTick(d)).outcome).toBe("failed");
    expect(notes).toHaveLength(1);
    clean(notes[0]!);
    expect(restarts).toEqual([]);
  });

  test("[验收线 2] 网页 error：shell 失败时带的输出脱敏", async () => {
    const { post, restarts } = web(gate(["0.159.3"]), { ok: false, tail: TAIL });
    const { status, body } = await post();
    expect(status).toBe(500);
    expect(body).toEqual({ ok: false, error: `Codex 更新失败：${redactShellTail(TAIL)}` });
    clean(JSON.stringify(body));
    expect(restarts).toEqual([]);
  });

  test("[验收线 2] 网页 output：成功、复核没过、对账失败、重启失败四条路都脱敏", async () => {
    const shell = { ok: true, tail: TAIL };
    const responses = [
      await web(gate(["0.159.3", "0.160.1"]), shell).post(),
      await web(gate(["0.159.3"]), shell).post(),
      await web(async () => ({ command: "npm i", afterShell: async () => { throw new Error("对账失败"); } }), shell).post(),
      await web(gate(["0.159.3", "0.160.1"]), shell).post({ ok: false, error: "起不来" }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 500, 500, 500]);
    for (const { body } of responses) {
      expect(body.output).toBe(redactShellTail(TAIL));
      clean(JSON.stringify(body));
    }
  });
});
