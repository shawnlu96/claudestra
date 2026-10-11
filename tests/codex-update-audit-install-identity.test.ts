/**
 * hardening-CODEXUP1 第 2 轮：安装身份按全局包根目录核（审查 install-identity），shell 输出外发前脱敏（shell-tail），
 * 安装复核异常的文案点明不是适配器问题（web-mismatch）。
 * 探测走真的 probeCodexInstall（CODEX_TUI_BIN 指到 fake 路径 + fake Runner），npm / shell / 重启 / 通知全 fake。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { codexAutoUpdateTick, type CodexAutoDeps } from "../src/lib/codex-auto-update";
import { prepareCodexUpdate } from "../src/lib/codex-auto-update-gate";
import { CodexInstallMismatch, redactShellTail, verifyCodexInstall } from "../src/lib/codex-update-install";
import { npmCodexPrefix, probeCodexInstall } from "../src/lib/codex-version";

const A = "/fake/prefix-a";
const GLOBAL = `${A}/lib/node_modules/@openai/codex/bin/codex.js`;
const LOCAL = `${A}/node_modules/@openai/codex/bin/codex.js`;
const ACP = (name: string) => ({ name, runtime: "codex", transport: "acp", status: "active" });

const savedBin = process.env.CODEX_TUI_BIN;
afterEach(() => {
  if (savedBin === undefined) delete process.env.CODEX_TUI_BIN;
  else process.env.CODEX_TUI_BIN = savedBin;
});

/** 真实 probeCodexInstall：每次探测依次解析到 seq 里的 [路径, 版本]（用完停在最后一个） */
function realProbe(seq: [string, string][]) {
  let i = 0;
  return async () => {
    const [path, version] = seq[Math.min(i++, seq.length - 1)]!;
    process.env.CODEX_TUI_BIN = path;
    return probeCodexInstall(async () => ({ ok: true, out: `codex-cli ${version}`, err: "", code: 0 }) as never);
  };
}

function rig(probe: () => ReturnType<typeof probeCodexInstall>, shellTail = { ok: true, tail: "added 1 package" }) {
  const log: string[] = [];
  const notes: string[] = [];
  const d: CodexAutoDeps = {
    now: () => 1_000_000_000,
    enabled: async () => true,
    installed: probe,
    latest: async () => "0.160.1",
    agents: async () => [ACP("agent-a")],
    busy: async () => [],
    lock: async () => ({ release: () => {} }),
    prepare: () => prepareCodexUpdate({
      install: probe,
      latest: async () => "0.160.1",
      adapter: () => null,
      selected: () => "upstream",
      npmFor: (prefix: string) => ({ npm: `${prefix}/bin/npm`, binDir: `${prefix}/bin` }),
    }),
    shell: async (cmd) => (log.push(`shell:${cmd}`), shellTail),
    restart: async (name) => (log.push(`restart:${name}`), { ok: true }),
    notify: async (text) => (notes.push(text), true),
    log: () => {},
    load: () => ({}),
    save: () => {},
  };
  return { d, log, notes };
}
const restarts = (log: string[]) => log.filter((l) => l.startsWith("restart"));

describe("安装身份 = 全局包根目录", () => {
  test("[验收线 2] 全局 → 同前缀下的本地包（目标版本）：failed、零重启、不报已更新", async () => {
    const { d, log, notes } = rig(realProbe([[GLOBAL, "0.159.3"], [GLOBAL, "0.159.3"], [LOCAL, "0.160.1"]]));
    expect((await codexAutoUpdateTick(d)).outcome).toBe("failed");
    expect(restarts(log)).toEqual([]);
    expect(notes.join("\n")).not.toContain("已自动更新");
    expect(notes.join("\n")).not.toContain("/fake");
  });

  test("[验收线 2] 全局包内原生二进制布局变化（同一包根目录）仍算同一份安装", async () => {
    const native = `${A}/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`;
    const { d, log } = rig(realProbe([[GLOBAL, "0.159.3"], [GLOBAL, "0.159.3"], [native, "0.160.1"]]));
    expect((await codexAutoUpdateTick(d)).outcome).toBe("updated");
    expect(restarts(log)).toEqual(["restart:agent-a"]);
  });

  test("[验收线 2] 一开始就是项目本地包：拒自动升级，不跑 shell", async () => {
    expect(npmCodexPrefix(LOCAL)).toBeUndefined();
    const probe = realProbe([[LOCAL, "0.159.3"]]);
    expect(await prepareCodexUpdate({ install: probe, latest: async () => "0.160.1" })).toMatchObject({ status: 400 });
    const { d, log } = rig(probe);
    expect((await codexAutoUpdateTick(d)).outcome).not.toBe("updated");
    expect(log.filter((l) => l.startsWith("shell:"))).toEqual([]);
  });

  test("verifyCodexInstall：同前缀不同包根目录 / 安装后没有包根目录都抛", async () => {
    const before = { version: "0.1.0", npm: true, prefix: A, root: `${A}/lib/node_modules/@openai/codex` };
    for (const now of [{ version: "0.2.0", npm: true, prefix: A, root: `${A}/other/@openai/codex` }, { version: "0.2.0", npm: true, prefix: A }]) {
      const e = await verifyCodexInstall(before, "0.2.0", async () => now).then(() => null, (x) => x);
      expect(e).toBeInstanceOf(CodexInstallMismatch);
    }
  });
});

describe("外发文案", () => {
  test("安装复核异常点明升级没生效、不是适配器问题（网页原样拼进错误）", () => {
    const m = new CodexInstallMismatch("实际在用的 codex 仍是 0.1.0").message;
    expect(m).toStartWith("Codex 升级没生效");
    expect(m).toContain("不用跑 acp-install");
  });

  test("shell 失败：通知里的 npm 输出脱敏（路径、凭据、令牌）", async () => {
    const tail = [
      "npm error path /fake/private-prefix/lib/node_modules/@openai/codex",
      "npm error A complete log of this run can be found in: ~/.npm/_logs/x-debug-0.log",
      "npm error 401 https://alice:s3cret@registry.example.com/@openai%2fcodex",
      "//registry.example.com/:_authToken=abc123 npm_abcdefghijklmnopqrstuvwxyz0123456789",
    ].join("\n");
    const { d, log, notes } = rig(realProbe([[GLOBAL, "0.159.3"]]), { ok: false, tail });
    expect((await codexAutoUpdateTick(d)).outcome).toBe("failed");
    expect(restarts(log)).toEqual([]);
    const text = notes.join("\n");
    for (const leak of ["/fake", "~/.npm", "alice", "s3cret", "abc123", "npm_abcdef"]) expect(text).not.toContain(leak);
    expect(text).toContain("npm error path <路径>");
    expect(text).toContain("registry.example.com");
  });

  test("redactShellTail 不动普通文字和 URL 主机", () => {
    expect(redactShellTail("npm error code E404\nhttps://registry.npmjs.org/x")).toBe("npm error code E404\nhttps://registry.npmjs.org/x");
  });
});
