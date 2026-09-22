/**
 * 为 Codex 抽出来的共享件，Claude Code 侧必须逐字不变：
 * - channel-server 的 MCP instructions（抽成 channelInstructions 前后同一份文字）
 * - claude 二进制的登录 shell 探测命令（泛化成 resolveLoginBinary 前后同一条）
 * 以及 typing-hook 的 Interrupt → StopFailure 映射（真起 hook 进程打到本地假 bridge）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { channelInstructions } from "../src/lib/channel-instructions.js";
import { loginResolveCommand, resolveLoginBinary } from "../src/lib/login-binary.js";
import { resolveClaudeBinary } from "../src/lib/claude-binary.js";

const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

test("channelInstructions 与抽取前的内联文本逐字一致", () => {
  // 摘要取自抽取前 HEAD(cf18087) 的 channel-server.ts，CLAUDESTRA_HOME="/HOME/X"
  const t = channelInstructions("/HOME/X");
  expect(t.length).toBe(2481);
  expect(sha(t)).toBe("3b01aa691e81250dc0ee508d658e38445e5a8bf906c8c47b7ccbceb921052fd1");
  expect(t).toContain('bun /HOME/X/src/discord-reply.ts "<chat_id>" "<text>"');
});

describe("登录 shell 解析", () => {
  test("claude 的探测命令逐字不变", async () => {
    expect(loginResolveCommand("claude")).toEqual([
      "/bin/sh",
      "-lc",
      'p="$(command -v claude)" && printf "%s\\n%s\\n" "$p" "$(realpath "$p")"',
    ]);
    let seen: string[] = [];
    await resolveClaudeBinary(async (cmd) => { seen = cmd; return { ok: false, out: "", err: "" }; });
    expect(seen).toEqual(loginResolveCommand("claude"));
  });
  test("名字进 sh -lc，只收安全字符", async () => {
    expect(() => loginResolveCommand("codex; rm -rf ~")).toThrow();
    expect(await resolveLoginBinary(async () => ({ ok: true, out: "/a/codex\n/b/codex.js\n", err: "" }), "codex"))
      .toEqual({ link: "/a/codex", real: "/b/codex.js" });
  });
});

describe("typing-hook：Codex 的 Interrupt 按 StopFailure 报给 bridge", () => {
  const got: any[] = [];
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        got.push(await req.json().catch(() => null));
        return Response.json({ ok: true });
      },
    });
  });
  afterAll(() => server.stop(true));

  async function runHook(event: string) {
    const port = String(server.port);
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "hooks", "typing-hook.ts")], {
      stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: event, session_id: "s" })),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, DISCORD_CHANNEL_ID: "999000333", BRIDGE_PORT: port, BRIDGE_URL: `ws://127.0.0.1:${port}` },
    });
    await proc.exited;
    return new Response(proc.stdout).text();
  }

  test("Interrupt → StopFailure；Stop 原样", async () => {
    await runHook("Interrupt");
    await runHook("Stop");
    expect(got.map((b) => b?.event)).toEqual(["StopFailure", "Stop"]);
    expect(got[0].channelId).toBe("999000333");
  });
});
