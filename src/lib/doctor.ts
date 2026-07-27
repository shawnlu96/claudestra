/**
 * `manager.ts doctor` —— 一条命令体检整套安装。
 *
 * 存在的理由是**支持成本**：把这套东西给别人用之后，对方卡住时你能拿到的只有
 * 一句「bot 不理我」。这个命令的输出是给他截图发你的 —— 所以每一项都要说清
 * 「是什么坏了」和「怎么修」，而不是打印一堆内部状态让人自己悟。
 *
 * 设计约束：
 * - **只读**。不修任何东西，不启任何 daemon。体检本身绝不能改变现场。
 * - **不因为一项失败就中断**。每项独立 try/catch，坏的越多越要全部报出来。
 * - **不打印密钥**。token / secret 一律只报「有没有」和长度。
 */

import { existsSync } from "fs";
import { readFile, stat } from "fs/promises";
import { resolveBunPath } from "./bun-path.js";
import { readRegistryAgents } from "./registry.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  /** 分区名，用于输出时分组 */
  group: string;
  name: string;
  status: CheckStatus;
  /** 一行结论；ok 时是版本/数量等事实，warn/fail 时是症状 */
  detail: string;
  /** 仅 warn/fail：怎么修 */
  fix?: string;
}

const HOME = process.env.HOME || "";
const ORCH_DIR = `${HOME}/.claude-orchestrator`;

async function sh(cmd: string[], timeoutMs = 8000): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* 已退出 */ } }, timeoutMs);
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const code = await p.exited;
    clearTimeout(timer);
    return { ok: code === 0, out: out.trim(), err: err.trim() };
  } catch (e) {
    return { ok: false, out: "", err: (e as Error).message };
  }
}

/** 取第一行、砍到 80 字符 —— 版本号打印用，避免某些 CLI 吐一整屏 banner */
function firstLine(s: string): string {
  return (s.split("\n")[0] || "").slice(0, 80);
}

// ────────────────────────────────────────────
// 各分区
// ────────────────────────────────────────────

async function checkRuntime(): Promise<Check[]> {
  const out: Check[] = [];
  const g = "运行时";

  const bunPath = resolveBunPath();
  const bunV = await sh([bunPath, "--version"]);
  out.push(bunV.ok
    ? { group: g, name: "bun", status: "ok", detail: `${firstLine(bunV.out)} @ ${bunPath}` }
    : { group: g, name: "bun", status: "fail", detail: `跑不起来：${bunPath}`,
        fix: "重装 bun：curl -fsSL https://bun.sh/install | bash，然后重跑 bun src/manager.ts install-cli（plist 里写的是 bun 的绝对路径）" });

  // 能力探测而不是解析版本号：Bun.Terminal（PTY）缺失时 web 远程终端会在 spawn
  // 时才炸（前端只看到连不上），doctor 提前把它点名（2026-07-27 peer 实例实况）
  if (bunV.ok) {
    const pty = await sh([bunPath, "-e", "process.stdout.write(typeof Bun.Terminal)"]);
    if (pty.ok && pty.out.trim() !== "function") {
      out.push({ group: g, name: "bun PTY", status: "warn",
        detail: `Bun ${firstLine(bunV.out)} 没有 Bun.Terminal API —— web 远程终端不可用`,
        fix: "bun upgrade 到 ≥ 1.3.5，然后 launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge" });
    }
  }

  const claude = await sh(["claude", "--version"]);
  out.push(claude.ok
    ? { group: g, name: "claude", status: "ok", detail: firstLine(claude.out) }
    : { group: g, name: "claude", status: "fail", detail: "PATH 里找不到 claude",
        fix: "装 Claude Code：npm i -g @anthropic-ai/claude-code（或 brew install --cask claude-code）" });

  const tmux = await sh(["tmux", "-V"]);
  out.push(tmux.ok
    ? { group: g, name: "tmux", status: "ok", detail: firstLine(tmux.out) }
    : { group: g, name: "tmux", status: "fail", detail: "PATH 里找不到 tmux",
        fix: "brew install tmux（agent 全都跑在 tmux window 里，没有它整套跑不起来）" });

  if (process.platform !== "darwin") {
    out.push({ group: g, name: "平台", status: "warn", detail: `${process.platform} —— launchd 是 macOS 专有`,
      fix: "非 macOS 上三个 daemon 装不上，需要自己用 systemd/supervisor 托管 bridge、launcher、cron" });
  }
  return out;
}

async function checkConfig(repoRoot: string): Promise<Check[]> {
  const out: Check[] = [];
  const g = "配置";
  const envPath = `${repoRoot}/.env`;

  if (!existsSync(envPath)) {
    out.push({ group: g, name: ".env", status: "fail", detail: "不存在",
      fix: "跑 bun run setup 生成" });
    return out;
  }

  const st = await stat(envPath);
  const mode = (st.mode & 0o777).toString(8);
  out.push(mode === "600"
    ? { group: g, name: ".env 权限", status: "ok", detail: `0${mode}` }
    : { group: g, name: ".env 权限", status: "warn", detail: `0${mode} —— 同机其他用户可读，里面有 bot token`,
        fix: `chmod 600 ${envPath}` });

  const env: Record<string, string> = {};
  for (const line of (await readFile(envPath, "utf-8")).split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]!] = m[2]!.trim();
  }

  const webOnly = !env.DISCORD_BOT_TOKEN;
  if (webOnly) {
    out.push({ group: g, name: "前端模式", status: "ok", detail: "Web-only（没配 DISCORD_BOT_TOKEN）" });
  } else {
    const ids = (env.ALLOWED_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const valid = ids.filter((s) => /^\d{17,20}$/.test(s));
    if (valid.length > 0) {
      out.push({ group: g, name: "Discord 门禁", status: "ok", detail: `${valid.length} 个合法 owner` });
    } else {
      out.push({ group: g, name: "Discord 门禁", status: "fail",
        detail: ids.length === 0 ? "ALLOWED_USER_IDS 为空 —— 门禁是 fail-closed，所有 Discord 消息都会被静默拒绝"
                                 : `ALLOWED_USER_IDS 里没有合法 ID（${ids.join(", ")}）—— 应为 17-20 位数字`,
        fix: "开发者模式下右键自己头像 → 复制用户 ID，填进 .env 的 ALLOWED_USER_IDS，然后重启 bridge" });
    }
    for (const key of ["DISCORD_GUILD_ID", "CONTROL_CHANNEL_ID"]) {
      if (!env[key]) out.push({ group: g, name: key, status: "warn", detail: "未设置", fix: "重跑 bun run setup" });
    }
  }

  const principalsPath = `${ORCH_DIR}/principals.json`;
  if (existsSync(principalsPath)) {
    const pst = await stat(principalsPath);
    const pmode = (pst.mode & 0o777).toString(8);
    if (pmode !== "600") {
      out.push({ group: g, name: "principals.json 权限", status: "warn", detail: `0${pmode} —— 里面是 API token 明文`,
        fix: `chmod 600 ${principalsPath}` });
    }
  }
  return out;
}

/**
 * `launchctl list` 一行里的 (pid, last exit status) → 结论。
 *
 * 关键在于**负数不等于崩溃**：负数是「被信号终止」，而 -15(SIGTERM) 正是
 * `launchctl kickstart -k` 和正常 stop 的结果。曾经把它一律报成「崩过」，
 * 于是每次重启 bridge 之后 doctor 都亮黄灯 —— 几次之后人就不看警告了，
 * 这比不报警更糟。只有进程自己 exit 非 0、或 -9(SIGKILL，多半 OOM 或被强杀)
 * 才值得提。
 */
export function classifyDaemonExit(pid: string, exit: string): { status: CheckStatus; detail: string } {
  const code = parseInt(exit) || 0;
  if (pid === "-") return { status: "fail", detail: `没在跑（上次退出状态 ${exit}）` };
  if (code === 0) return { status: "ok", detail: `pid ${pid}` };
  if (code === -15 || code === -2 || code === -1) return { status: "ok", detail: `pid ${pid}` };
  if (code === -9) return { status: "warn", detail: `pid ${pid} 在跑，但上次是被 SIGKILL 强杀的（OOM？）` };
  return { status: "warn", detail: `pid ${pid} 在跑，但上次异常退出（code ${exit}）` };
}

async function checkDaemons(): Promise<Check[]> {
  const out: Check[] = [];
  const g = "launchd daemon";
  if (process.platform !== "darwin") return out;

  const list = await sh(["launchctl", "list"]);
  for (const label of ["com.claudestra.bridge", "com.claudestra.launcher", "com.claudestra.cron"]) {
    const plist = `${HOME}/Library/LaunchAgents/${label}.plist`;
    const line = list.out.split("\n").find((l) => l.endsWith(label) || l.includes(`\t${label}`));
    if (!line) {
      out.push({ group: g, name: label, status: existsSync(plist) ? "fail" : "warn",
        detail: existsSync(plist) ? "plist 在，但没 load" : "没装",
        fix: "bun src/manager.ts install-cli" });
      continue;
    }
    // launchctl list 输出：<pid>\t<last exit status>\t<label>
    const [pidRaw, exitRaw] = line.split("\t");
    const pid = (pidRaw || "").trim();
    const exit = (exitRaw || "").trim();
    const v = classifyDaemonExit(pid, exit);
    const logFile = `/tmp/claudestra-${label.split(".").pop()}.err`;
    out.push({
      group: g, name: label, status: v.status, detail: v.detail,
      fix: v.status === "fail"
        ? `launchctl kickstart -k gui/$(id -u)/${label}，起不来就看日志 ${logFile}`
        : v.status === "warn" ? `看日志 ${logFile}` : undefined,
    });
  }
  return out;
}

async function checkBridge(repoRoot: string): Promise<Check[]> {
  const out: Check[] = [];
  const g = "bridge";
  let port = 3847;
  try {
    const envTxt = await readFile(`${repoRoot}/.env`, "utf-8");
    const m = envTxt.match(/^\s*BRIDGE_PORT\s*=\s*(\d+)/m);
    if (m) port = parseInt(m[1]!);
  } catch { /* 用默认端口 */ }

  const lsof = await sh(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  const listeners = lsof.out.split("\n").slice(1).filter(Boolean);
  if (listeners.length === 0) {
    out.push({ group: g, name: `端口 ${port}`, status: "fail", detail: "没有进程在监听",
      fix: `launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge` });
  } else if (listeners.length > 1) {
    out.push({ group: g, name: `端口 ${port}`, status: "warn", detail: `${listeners.length} 个监听者 —— 可能跑了两份 bridge`,
      fix: "kill 掉多余的实例，只留 launchd 那份（launchctl list | grep claudestra）" });
  } else {
    out.push({ group: g, name: `端口 ${port}`, status: "ok", detail: firstLine(listeners[0]!.replace(/\s+/g, " ")) });
  }

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(`http://127.0.0.1:${port}/stats`, { signal: ctl.signal });
    clearTimeout(timer);
    out.push(res.ok
      ? { group: g, name: "HTTP /stats", status: "ok", detail: `HTTP ${res.status}` }
      : { group: g, name: "HTTP /stats", status: "warn", detail: `HTTP ${res.status}`,
          fix: "看 /tmp/claudestra-bridge.err" });
  } catch (e) {
    out.push({ group: g, name: "HTTP /stats", status: "fail", detail: `连不上（${(e as Error).message}）`,
      fix: "bridge 没起来或崩了：launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge" });
  }
  return out;
}

async function checkIntegration(repoRoot: string): Promise<Check[]> {
  const out: Check[] = [];
  const g = "Claude Code 集成";
  const mcpName = process.env.MCP_NAME || "claudestra";

  const mcp = await sh(["claude", "mcp", "list"], 15000);
  if (!mcp.ok) {
    out.push({ group: g, name: "MCP 注册", status: "warn", detail: "claude mcp list 跑不通，无法确认",
      fix: `手动确认：claude mcp list | grep ${mcpName}` });
  } else if (mcp.out.includes(mcpName)) {
    out.push({ group: g, name: "MCP 注册", status: "ok", detail: `${mcpName} 已注册` });
  } else {
    out.push({ group: g, name: "MCP 注册", status: "fail", detail: `没找到 ${mcpName} —— agent 收得到消息但回不了话`,
      fix: `claude mcp add ${mcpName} -s user -- bun run ${repoRoot}/src/channel-server.ts` });
  }

  const settingsPath = `${HOME}/.claude/settings.json`;
  if (!existsSync(settingsPath)) {
    out.push({ group: g, name: "typing hooks", status: "warn", detail: "~/.claude/settings.json 不存在",
      fix: "重跑 bun run setup" });
  } else {
    const txt = await readFile(settingsPath, "utf-8").catch(() => "");
    out.push(txt.includes("typing-hook")
      ? { group: g, name: "typing hooks", status: "ok", detail: "Stop / Notification 已挂" }
      : { group: g, name: "typing hooks", status: "warn", detail: "没挂 —— 输入指示器不会自动停，完成通知会迟",
          fix: "重跑 bun run setup" });
  }
  return out;
}

async function checkAgents(): Promise<Check[]> {
  const out: Check[] = [];
  const g = "agent";

  let agents: Array<{ name: string }> = [];
  try {
    agents = (await readRegistryAgents()).map((a) => ({ name: a.name }));
  } catch (e) {
    out.push({ group: g, name: "registry.json", status: "fail", detail: `读不了：${(e as Error).message}`,
      fix: `检查 ${ORCH_DIR}/registry.json 是不是坏了（应是 JSON 对象）` });
    return out;
  }
  out.push({ group: g, name: "registry.json", status: "ok", detail: `${agents.length} 个 agent` });

  const sock = "/tmp/claude-orchestrator/master.sock";
  const win = await sh(["tmux", "-S", sock, "list-windows", "-t", "master", "-F", "#{window_name}"]);
  if (!win.ok) {
    out.push({ group: g, name: "master tmux session", status: agents.length > 0 ? "fail" : "warn",
      detail: "不存在 —— 所有 agent 都不在跑",
      fix: "launchctl kickstart -k gui/$(id -u)/com.claudestra.launcher（launcher 负责把 master session 拉起来）" });
    return out;
  }
  const windows = new Set(win.out.split("\n").map((s) => s.trim()).filter(Boolean));
  const missing = agents.filter((a) => !windows.has(a.name)).map((a) => a.name);
  out.push(missing.length === 0
    ? { group: g, name: "tmux window", status: "ok", detail: `${windows.size} 个 window，registry 里的 agent 都在` }
    : { group: g, name: "tmux window", status: "warn", detail: `registry 里有但 tmux 里没有：${missing.join(", ")}`,
        fix: `bun src/manager.ts restart <name> 重新拉起，或 bun src/manager.ts remove <name> 清掉登记` });
  return out;
}

// ────────────────────────────────────────────
// 入口
// ────────────────────────────────────────────

export async function runDoctor(repoRoot: string): Promise<Check[]> {
  const groups = await Promise.all([
    checkRuntime(),
    checkConfig(repoRoot),
    checkDaemons(),
    checkBridge(repoRoot),
    checkIntegration(repoRoot),
    checkAgents(),
  ]);
  return groups.flat();
}

const ICON: Record<CheckStatus, string> = { ok: "✅", warn: "⚠️ ", fail: "❌" };

/** 人类可读输出 —— 这个命令的产物是给人截图发给维护者的，不是给程序解析的 */
export function formatDoctor(checks: Check[]): string {
  const lines: string[] = [];
  let lastGroup = "";
  for (const ch of checks) {
    if (ch.group !== lastGroup) {
      lines.push("", `── ${ch.group} ──`);
      lastGroup = ch.group;
    }
    lines.push(`${ICON[ch.status]} ${ch.name}: ${ch.detail}`);
    if (ch.fix) lines.push(`     ↳ ${ch.fix}`);
  }
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  lines.push("");
  if (fails === 0 && warns === 0) lines.push("✅ 全部正常。");
  else if (fails === 0) lines.push(`⚠️  ${warns} 项警告 —— 不影响运行，但值得看一眼。`);
  else lines.push(`❌ ${fails} 项失败${warns > 0 ? `，${warns} 项警告` : ""} —— 先处理标 ❌ 的。`);
  return lines.join("\n");
}
