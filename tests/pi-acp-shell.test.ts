/**
 * Pi 适配器的进程外壳：真起 `bun main.ts`，pi 换成临时目录里的假可执行文件（PI_BIN），它把自己的 argv / 挂 MCP 的环境变量 / cwd
 * 记进日志、对启动三问给固定回包。钉住：实际起 pi 的命令行里有 `-e builtin:mcp`；/clear（再来一次 session/new）停掉旧 pi 换新 id；
 * resume 用给定 id；宿主关 stdin 时适配器带走 pi、以 0 退出。PI_CODING_AGENT_DIR 指到临时目录：挂 MCP 前的撞名闸不读真 ~/.pi。
 */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAdapter } from "../src/lib/acp/adapter-proc.ts";
import { ACTIVATE_TOOLS_EXTENSION, MCP_MOUNT_EXTENSION, PI_ENV_SNAPSHOT_EXTENSION } from "../src/lib/acp/pi-adapter/args.ts";
import { PI_ACP_ADAPTER_MAIN } from "../src/lib/acp/pi-adapter/main.ts";
import { MOUNT_OK, MOUNT_STATUS_KEY, PI_MCP_SERVERS_ENV } from "../src/lib/acp/pi-adapter/mcp-mount.ts";
import { AcpSession } from "../src/lib/acp/session.ts";
import { testChildEnv } from "./test-env.ts";

const root = mkdtempSync(join(tmpdir(), "pi-acp-shell-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const FAKE_PI = `#!${process.execPath}
import { appendFileSync } from "node:fs";
const log = (o) => appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(o) + "\\n");
log({ argv: process.argv.slice(2), mcp: process.env.${PI_MCP_SERVERS_ENV} ?? null, cwd: process.cwd() });
// 挂了 server 时真 pi 里的挂载扩展会在读命令之前报状态（mcp-mount.ts）
const status = { type: "extension_ui_request", id: "m", method: "setStatus", statusKey: "${MOUNT_STATUS_KEY}", statusText: "${MOUNT_OK}" };
if (process.env.${PI_MCP_SERVERS_ENV}) process.stdout.write(JSON.stringify(status) + "\\n");
const DATA = {
  get_state: { model: { provider: "ds", id: "v4", name: "V4" }, thinkingLevel: "off" },
  get_available_models: { models: [{ provider: "ds", id: "v4", name: "V4" }] },
  get_available_thinking_levels: { levels: ["off"] },
};
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    process.stdout.write(JSON.stringify({ id: m.id, type: "response", command: m.type, success: true, data: DATA[m.type] ?? {} }) + "\\n");
  }
});
process.stdin.on("end", () => (log({ exit: true }), process.exit(0)));
process.stderr.write("fake pi up\\n");
`;

test("起 pi 的命令行带 -e builtin:mcp；/clear 换新 pi；resume 用给定 id；关 stdin 带走 pi 并以 0 退出", async () => {
  const fake = join(root, "pi");
  writeFileSync(fake, FAKE_PI);
  chmodSync(fake, 0o755);
  const logFile = join(root, "pi.log");
  const logs: string[] = [];
  const env = testChildEnv({ PI_BIN: fake, FAKE_PI_LOG: logFile, PI_CODING_AGENT_DIR: root });
  const proc = spawnAdapter([process.execPath, PI_ACP_ADAPTER_MAIN, "--no-extensions"], env, root, (l) => logs.push(l), "pi-acp");
  const session = new AcpSession(proc.wire, { onUpdate: () => {}, onPermission: async () => null, log: (l) => logs.push(l) });
  const piRuns = () => readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  try {
    await session.initialize();
    const servers = [{ name: "claudestra", command: "/bin/echo", args: ["x"], env: [{ name: "A", value: "1" }] }];
    const first = await session.rpc.request("session/new", { cwd: root, mcpServers: servers }, { timeoutMs: 20_000 });
    expect(first.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(piRuns()[0]).toEqual({
      argv: [
        "--mode", "rpc", "--no-extensions",
        "-e", "builtin:mcp", "-e", MCP_MOUNT_EXTENSION, "-e", ACTIVATE_TOOLS_EXTENSION, "-e", PI_ENV_SNAPSHOT_EXTENSION,
        "--session-id", first.sessionId,
      ],
      mcp: JSON.stringify({ claudestra: { command: "/bin/echo", args: ["x"], env: { A: "1" } } }),
      cwd: realpathSync(root),
    });

    const second = await session.rpc.request("session/new", { cwd: root, mcpServers: [] }, { timeoutMs: 20_000 });
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(piRuns().slice(1).map((r) => r.exit ?? r.argv.at(-1))).toEqual([true, second.sessionId]);
    expect(piRuns()[2].mcp).toBeNull();

    await session.rpc.request("session/resume", { sessionId: first.sessionId, cwd: root, mcpServers: [] }, { timeoutMs: 20_000 });
    expect(piRuns().slice(3).map((r) => r.exit ?? r.argv.at(-1))).toEqual([true, first.sessionId]);
    expect(logs.some((l) => l.includes("[pi-acp] [pi] fake pi up"))).toBe(true);
  } finally {
    proc.stop();
  }
  expect(await proc.exited).toBe(0);
  expect(piRuns().at(-1)).toEqual({ exit: true });
}, 30_000);
