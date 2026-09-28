/**
 * tests/sandbox-isolation.test.ts 用的「假 Claude Code」：放在 PATH 最前面冒充 `claude`，但照真的那样
 * 用收到的环境跑 settings.json 里的 hooks 与 statusLine、按 --mcp-config 拉起 channel-server 并握手、
 * 往 ~/.claude/projects 写会话 jsonl、收到频道消息就调 reply 回一句 pong、然后跑 Stop hook。
 * 这样 agent 这一侧（channel-server / hooks / statusLine / 会话发现）的写入与出站都在受控测试里走一遍。
 */

/** 生成可执行脚本的源码（shebang 指向当前 bun）。log 记下每一步，失败时给断言看 */
export function fakeClaudeSource(bunPath: string, logPath: string): string {
  return `#!${bunPath}
import { appendFileSync, mkdirSync, openSync, readFileSync } from "fs";
import { join } from "path";
const LOG = ${JSON.stringify(logPath)};
const log = (s) => appendFileSync(LOG, "fake-claude " + s + "\\n");
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (argv[0] === "agents") { console.log("[]"); process.exit(0); }
const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const sid = flag("--session-id") ?? "no-session";
const home = process.env.HOME, cwd = process.cwd();
log("start sid=" + sid + " strict=" + argv.includes("--strict-mcp-config") + " state=" + process.env.CLAUDESTRA_STATE_DIR);
const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
const hookCmds = (ev) => (settings.hooks?.[ev] ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command));
async function sh(cmd, input) {
  const p = Bun.spawn(["/bin/sh", "-c", cmd], { stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe", env: process.env });
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  log("ran " + cmd.split("/").pop() + " code=" + code + (err.trim() ? " err=" + err.trim().slice(0, 300).replace(/\\n/g, " | ") : ""));
}
const proj = join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
mkdirSync(proj, { recursive: true });
appendFileSync(join(proj, sid + ".jsonl"), JSON.stringify({ type: "user", sessionId: sid, cwd, timestamp: new Date().toISOString(),
  message: { role: "user", content: "hi" } }) + "\\n");
for (const c of hookCmds("SessionStart")) await sh(c, { hook_event_name: "SessionStart", session_id: sid, cwd, source: "startup" });
if (settings.statusLine?.command) await sh(settings.statusLine.command, { session_id: sid, cwd, model: { display_name: "Fake" },
  context_window: { context_window_size: 200000, used_percentage: 1, remaining_percentage: 99 },
  rate_limits: { five_hour: { used_percentage: 5, resets_at: 1 }, seven_day: { used_percentage: 7, resets_at: 2 } } });
const srv = Object.values(JSON.parse(flag("--mcp-config") ?? "{}").mcpServers ?? {})[0];
if (!srv) { log("no --mcp-config"); process.exit(3); }
const child = Bun.spawn([srv.command, ...srv.args], { stdin: "pipe", stdout: "pipe", stderr: openSync(LOG + ".mcp-stderr", "a"), env: process.env });
const send = (m) => { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n"); child.stdin.flush(); };
send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } } });
setTimeout(() => process.exit(0), 120_000);
let buf = "", nextId = 2;
for await (const chunk of child.stdout) {
  buf += new TextDecoder().decode(chunk);
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1) {
      send({ method: "notifications/initialized" });
      log("mcp initialized");
      console.log("\\n" + "─".repeat(40) + "\\n❯ \\n" + "─".repeat(40) + "\\n  ⏵⏵ bypass permissions on (shift+tab to cycle)");
    } else if (m.method === "notifications/claude/channel") {
      log("channel message " + JSON.stringify(m.params?.content ?? "").slice(0, 80));
      send({ id: nextId++, method: "tools/call", params: { name: "reply", arguments: { chat_id: m.params?.meta?.chat_id, text: "pong" } } });
      for (const c of hookCmds("Stop")) await sh(c, { hook_event_name: "Stop", session_id: sid, cwd, stop_hook_active: false });
    } else if (m.id && m.result) {
      log("tool result " + JSON.stringify(m.result).slice(0, 120));
    }
  }
}
`;
}
