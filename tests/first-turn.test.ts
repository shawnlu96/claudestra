/**
 * restart 靠 registry 的 firstTurnAt 分辨「从没对话过」和「对话过、历史丢了」（审查 r2 P1-3）：
 * create 写 null，bridge 的 Stop hook 第一次见到回合时调 `manager mark-turn` 记时间，之后不再改。
 * 子进程跑真实的 manager.ts，状态、tmux socket 指到临时目录，bridge 指到没人听的端口，碰不到线上。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeRegistryAgents } from "../src/lib/registry.ts";

const dir = mkdtempSync(join(tmpdir(), "first-turn-"));
const state = join(dir, "state");

async function manager(...args: string[]): Promise<any> {
  const env: Record<string, string | undefined> = {
    ...process.env, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(dir, "run"), BRIDGE_URL: "ws://127.0.0.1:9", BRIDGE_PORT: "9",
  };
  delete env.DISCORD_CHANNEL_ID;
  const proc = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../src/manager.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(out.trim().split("\n").pop() || "{}");
}

const reg = () => JSON.parse(readFileSync(join(state, "registry.json"), "utf8")).agents;

describe("manager mark-turn", () => {
  test("null → 记下时间；再调不改；不存在的 agent 报错", async () => {
    mkdirSync(state, { recursive: true });
    mkdirSync(join(dir, "run"), { recursive: true });
    const agent = { cwd: dir, status: "active", channelId: "local-1", project: "", purpose: "", created: "", notes: "", firstTurnAt: null };
    writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents: { "agent-x": agent } }));
    const first = await manager("mark-turn", "x");
    expect(first.ok).toBe(true);
    expect(typeof reg()["agent-x"].firstTurnAt).toBe("string");
    const again = await manager("mark-turn", "agent-x");
    expect(again.firstTurnAt).toBe(first.firstTurnAt);
    expect(reg()["agent-x"].firstTurnAt).toBe(first.firstTurnAt);
    expect((await manager("mark-turn", "nobody")).ok).toBe(false);
  }, 60_000);
});

describe("registry 读者带出 firstTurnAt（bridge 据此决定要不要调 mark-turn）", () => {
  test("null / 时间 / 缺字段三种分开", () => {
    const agents = normalizeRegistryAgents({ agents: { a: { firstTurnAt: null }, b: { firstTurnAt: "2026-09-30T00:00:00Z" }, c: {} } });
    expect(agents.map((x) => x.firstTurnAt)).toEqual([null, "2026-09-30T00:00:00Z", undefined]);
  });
});
