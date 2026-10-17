/**
 * OCR-2 验收追加 6：ACP 宿主的启动命令要短于 1000 字节（tmux 在 zsh 就绪前送进 tty 的字符，macOS 规范模式只收前 1024 字节），
 * 大段文本（职责前言、developer 指令、Pi 参数）进一次性文件，宿主读回环境（lib/runtimes/acp-launch-payload.ts）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelInstructions } from "../src/lib/channel-instructions.ts";
import { ACP_LAUNCH_FILE_ENV, takeLaunchPayload, writeLaunchPayload } from "../src/lib/runtimes/acp-launch-payload.ts";
import { buildAcpHostCommand } from "../src/lib/runtimes/codex-acp.ts";
import { buildOpencodeAcpHostCommand } from "../src/lib/runtimes/opencode-acp.ts";
import { buildPiAcpHostCommand } from "../src/lib/runtimes/pi-acp.ts";
import type { LaunchSpec } from "../src/lib/runtimes/types.ts";

const REPO = join(import.meta.dir, "..");
// 真实长度：一段正常的职责 + 十几个同事的项目花名册；频道规则是仓库里的真文件（channelInstructions）
const PURPOSE = "OpenCode 试用 agent：在 /Users/x/topics/opencode-ds 里跟 owner 讨论选题、查资料、写草稿，用 deepseek 免费模型。".repeat(3);
const ROSTER = Array.from({ length: 14 }, (_, i) => `- agent-colleague-${i}（同项目协作者 ${i}：负责某一块代码与审查，在线）`).join("\n");
const SPEC: LaunchSpec = {
  mode: "new", channelId: "1532582506661150866", bridgeUrl: "ws://127.0.0.1:3847", sessionId: "ses_2f0a9c1d3e4b5a6978", agentName: "agent-opencode-ds",
  purpose: PURPOSE, projectContext: `你属于 project「claudestra」。同项目 agent:\n${ROSTER}`, model: "opencode/deepseek-v4.1-flash-free", cwd: "/w",
};
const MAX = 1000;

describe("启动命令短于 1000 字节，前言不在命令行里", () => {
  expect(channelInstructions(REPO).length).toBeGreaterThan(500); // 确实带上了真实规则

  const cases: [string, (w: typeof writeLaunchPayload) => string][] = [
    ["codex new", (w) => buildAcpHostCommand(SPEC, { bunBin: "/opt/bun", repoRoot: REPO, codexBin: "/usr/local/bin/codex", env: {}, writePayload: w })],
    ["codex resume", (w) => buildAcpHostCommand({ ...SPEC, mode: "resume" }, { bunBin: "/opt/bun", repoRoot: REPO, codexBin: "/usr/local/bin/codex", env: {}, writePayload: w })],
    ["pi", (w) => buildPiAcpHostCommand({ ...SPEC, sessionId: "019a-pi" }, { bunBin: "/opt/bun", repoRoot: REPO, env: {}, writePayload: w })],
    ["opencode new", (w) => buildOpencodeAcpHostCommand(SPEC, { bunBin: "/opt/bun", repoRoot: REPO, opencodeBin: "/nvm/bin/opencode", env: {}, writePayload: w })],
    ["opencode resume", (w) => buildOpencodeAcpHostCommand({ ...SPEC, mode: "resume" }, { bunBin: "/opt/bun", repoRoot: REPO, opencodeBin: "/nvm/bin/opencode", env: {}, writePayload: w })],
  ];

  for (const [name, build] of cases) {
    test(name, () => {
      let payload: [string, string | undefined][] = [];
      const cmd = build((pairs) => ((payload = pairs), "/state/run/acp-launch/0123456789abcdef.json"));
      expect(Buffer.byteLength(cmd)).toBeLessThan(MAX);
      expect(cmd).toContain(`${ACP_LAUNCH_FILE_ENV}=/state/run/acp-launch/0123456789abcdef.json`);
      for (const k of ["CLAUDESTRA_ACP_DEVELOPER", "CLAUDESTRA_CODEX_PREAMBLE", "CLAUDESTRA_ACP_CLEAR_PREAMBLE", "CLAUDESTRA_PI_ARGS"]) expect(cmd).not.toContain(`${k}=`);
      // 前言 / 参数一字不少地进了文件
      const text = payload.map(([k, v]) => (k === "CLAUDESTRA_PI_ARGS" ? v! : Buffer.from(v ?? "", "base64").toString("utf8"))).join("\n");
      expect(text).toContain(PURPOSE.slice(0, 30));
    });
  }
});

describe("一次性文件：写 0600、宿主读回环境即删、相同的值只存一份", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-launch-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("写读来回", () => {
    const big = "x".repeat(5000);
    const path = writeLaunchPayload([["CLAUDESTRA_CODEX_PREAMBLE", big], ["CLAUDESTRA_ACP_CLEAR_PREAMBLE", big], ["CLAUDESTRA_ACP_DEVELOPER", undefined]], dir)!;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(path).size).toBeLessThan(big.length + 200); // 两份相同的前言只存一份
    const env: Record<string, string | undefined> = { [ACP_LAUNCH_FILE_ENV]: path };
    takeLaunchPayload(env, dir);
    expect(env).toEqual({ CLAUDESTRA_CODEX_PREAMBLE: big, CLAUDESTRA_ACP_CLEAR_PREAMBLE: big });
    expect(existsSync(path)).toBe(false);
  });

  test("没东西可放不写文件；不收的键直接拒；目录外 / 名字不对的路径不读不删", () => {
    expect(writeLaunchPayload([["CLAUDESTRA_CODEX_PREAMBLE", undefined]], dir)).toBeUndefined();
    expect(() => writeLaunchPayload([["PATH", "/evil"]], dir)).toThrow("不收");
    const env: Record<string, string | undefined> = { [ACP_LAUNCH_FILE_ENV]: "/etc/passwd" };
    takeLaunchPayload(env, dir);
    expect(env).toEqual({});
    expect(existsSync("/etc/passwd")).toBe(true);
  });
});
