/**
 * save_handoff 的真实回路（codex-compact N3）：saveHandoffTool → 真 ws 客户端（照 channel-server 先 register、按 requestId 认回包）
 * → 真 startToolProxy → 内存 bridge 假件（只做 bridge.ts 那一行：把帧交真 answerSaveHandoff，回包经 proxy.onBridgeFrame）。
 * 身份用真 resolveCallerIdentity，凭据存储 / registry 由测试注入（等价于 bridge 的 callerOf），状态全在临时目录。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startToolProxy, type ToolProxy } from "../src/lib/acp/tool-proxy.ts";
import { readAgentHandoff } from "../src/lib/agent-handoff.ts";
import { resolveCallerIdentity } from "../src/lib/caller-identity.ts";
import { saveHandoffTool } from "../src/lib/compact-tools.ts";
import { answerSaveHandoff, type CallerOf } from "../src/bridge/handoff-route.ts";

const ME = "agent-codex-a";
const PM = "agent-pm";
const CH = "local-acp-1";
let root: string;
let stateDir: string;
let home: string;
let proxy: ToolProxy | null = null;
const opened: WebSocket[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "handoff-loop-"));
  stateDir = join(root, "state");
  home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
});
afterEach(() => {
  for (const ws of opened.splice(0)) ws.close();
  proxy?.close();
  proxy = null;
  rmSync(root, { recursive: true, force: true });
});

/** bridge 那头宿主的连接：登记过 CH、出示过签给 ME 的凭据；回包经它交回代理（同宿主把 bridge 帧先给 proxy.onBridgeFrame） */
let hostWs: { send(data: string): void } = { send: () => {} };
const callerOf: CallerOf = (ws, frame) => ({
  identity: resolveCallerIdentity(
    { credHash: ws === hostWs ? "h1" : undefined, channelId: CH, downgraded: frame?.callerDowngraded === true },
    { creds: { h1: { agent: ME, family: "codex", issuedAt: "2026-10-04T00:00:00Z" } }, agents: [{ name: ME, channelId: CH, runtime: "codex" }, { name: PM, channelId: "pm-ch" }] },
  ),
  channelId: CH,
});

function loop(clean = false) {
  const upstream: Record<string, any>[] = [];
  const logs: string[] = [];
  const p = startToolProxy({
    channelId: CH, clean, log: (m) => logs.push(m),
    toBridge: (frame) => {
      upstream.push(frame);
      void answerSaveHandoff(hostWs, frame, callerOf, { registered: () => [ME, PM], stateDir }); // = bridge.ts 的 case "save_handoff"
      return true;
    },
  });
  hostWs = { send: (data) => void p.onBridgeFrame(JSON.parse(data)) };
  proxy = p;
  return { proxy: p, upstream, logs };
}

/** channel-server 的连接：register 后按自增 requestId 发请求、按 id 认回包（同 channel-server doSend） */
async function client(url: string, register: Record<string, unknown> | null) {
  const ws = new WebSocket(url);
  opened.push(ws);
  const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const strays: any[] = [];
  let n = 0;
  let onRegistered: () => void = () => {};
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.type === "registered") return onRegistered();
    const h = pending.get(m.requestId);
    if (!h) return void strays.push(m);
    pending.delete(m.requestId);
    m.error ? h.reject(new Error(m.error)) : h.resolve(m.result);
  };
  await new Promise<void>((res, rej) => ((ws.onopen = () => res()), (ws.onerror = () => rej(new Error("connect failed")))));
  if (register) await new Promise<void>((res) => ((onRegistered = res), ws.send(JSON.stringify({ type: "register", channelId: CH, runtime: "codex", ...register }))));
  const request = (msg: Record<string, unknown>, timeoutMs = 3000) => new Promise<any>((resolve, reject) => {
    const requestId = `req_${++n}`;
    pending.set(requestId, { resolve, reject });
    setTimeout(() => pending.delete(requestId) && reject(new Error("Bridge 请求超时")), timeoutMs);
    ws.send(JSON.stringify({ ...msg, requestId }));
  });
  return { request, strays, raw: (m: object) => ws.send(JSON.stringify(m)) };
}

const claudeTree = () => readdirSync(join(home, ".claude"), { recursive: true });

describe("save_handoff 回路：工具 → 真代理 → 真 handoff-route", () => {
  test("Codex 起的 MCP 连接：写进临时 STATE_DIR 里自己的交接，回包按原 id 回到原连接", async () => {
    const { proxy, upstream } = loop();
    const c = await client(proxy.url, {});
    const r = await saveHandoffTool(c.request, { opId: "op-42", text: "# 交接\n下一步：跑测试" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain(join(stateDir, "handoff", ME, "HANDOFF.md"));
    expect(upstream).toHaveLength(1);
    expect(upstream[0]).toEqual({ type: "save_handoff", requestId: expect.stringMatching(/^acp\d+_req_1$/), opId: "op-42", text: "# 交接\n下一步：跑测试" });
    expect(c.strays).toEqual([]);
    expect(readAgentHandoff(ME, stateDir)).toMatchObject({ meta: { opId: "op-42", agent: ME }, text: "# 交接\n下一步：跑测试" });
    expect(claudeTree()).toEqual([]);
  });

  test("outsideMcpLauncher（shell 起的）连接：上送带降级标，route 拒写，工具拿到明确错误", async () => {
    const { proxy, upstream } = loop();
    const c = await client(proxy.url, { outsideMcpLauncher: true });
    const r = await saveHandoffTool(c.request, { opId: "op-1", text: "冒充" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("identity_unverified");
    expect(upstream[0]!.callerDowngraded).toBe(true);
    expect(existsSync(join(stateDir, "handoff"))).toBe(false);
  });

  test("没登记就发请求的连接同样降级、不写", async () => {
    const { proxy } = loop();
    const c = await client(proxy.url, null);
    const r = await saveHandoffTool(c.request, { opId: "op-1", text: "x" });
    expect(r.isError).toBe(true);
    expect(existsSync(join(stateDir, "handoff"))).toBe(false);
  });

  test("clean（出借 worker）代理：就地回错，假 bridge 零帧，什么都没写", async () => {
    const { proxy, upstream } = loop(true);
    const c = await client(proxy.url, {});
    const r = await saveHandoffTool(c.request, { opId: "op-1", text: "x" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("出借 worker 不转发 save_handoff");
    expect(upstream).toEqual([]);
    expect(existsSync(join(stateDir, "handoff"))).toBe(false);
  });

  test("冒名：帧自带 agent / name / path / callerCred / callerDowngraded:false，拿不到别人的写权", async () => {
    const { proxy } = loop();
    const shell = await client(proxy.url, { outsideMcpLauncher: true });
    await expect(shell.request({ type: "save_handoff", opId: "op-1", text: "x", agent: PM, callerCred: "f".repeat(64), callerDowngraded: false })).rejects.toThrow("identity_unverified");
    const mcp = await client(proxy.url, {});
    await expect(mcp.request({ type: "save_handoff", opId: "op-1", text: "x", agent: PM })).rejects.toThrow("不符");
    await expect(mcp.request({ type: "save_handoff", opId: "op-1", text: "x", name: PM })).rejects.toThrow("不符");
    await expect(mcp.request({ type: "save_handoff", opId: "op-1", text: "x", path: join(root, "evil.md") })).rejects.toThrow("落点只由 bridge 决定");
    expect(readAgentHandoff(PM, stateDir)).toBeNull();
    expect(readAgentHandoff(ME, stateDir)).toBeNull();
    expect(existsSync(join(root, "evil.md"))).toBe(false);
    // 带上和自己相同的名字不算冒名，照常写自己的
    expect(await mcp.request({ type: "save_handoff", opId: "op-2", text: "y", agent: ME })).toMatchObject({ agent: ME, opId: "op-2" });
  });

  test("超大 / 空文本经回路被拒，旧交接和 op 绑定不动", async () => {
    const { proxy } = loop();
    const c = await client(proxy.url, {});
    expect((await saveHandoffTool(c.request, { opId: "op-old", text: "旧" })).isError).toBeUndefined();
    const big = await saveHandoffTool(c.request, { opId: "op-big", text: "a".repeat(16 * 1024 + 1) });
    const empty = await saveHandoffTool(c.request, { opId: "op-empty", text: "  " });
    expect(big.isError && big.content[0]!.text).toContain("超过上限");
    expect(empty.isError && empty.content[0]!.text).toContain("不能为空");
    expect(readAgentHandoff(ME, stateDir)).toMatchObject({ meta: { opId: "op-old" }, text: "旧" });
  });
});
