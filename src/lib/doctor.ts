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

import { resolveBridgePort } from "./bridge-url.js";
import { parseDotenv, readDotenvFileSync } from "./env-file.js";
import { STATE_DIR, TMUX_SOCK, UNDELIVERED_ALERTS_LOG } from "./paths.js";
import { hasRecallHook, recallAvailable } from "./session-recall.js";
import { resolveLogPath } from "./log-paths.js";
import { existsSync, statSync } from "fs";
import { readFile, stat } from "fs/promises";
import { resolveBunPath } from "./bun-path.js";
import { readRegistryAgents, isMasterAgent } from "./registry.js";

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

import { installRepoSkills } from "./skills-install.js";

const HOME = process.env.HOME || "";
const ORCH_DIR = STATE_DIR;

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

  // doctor 看的是 daemon 实际会拿到的配置：只读文件，不看本终端 export 的变量
  const env = parseDotenv(await readFile(envPath, "utf-8"));

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
  // web 服务只在装过（plist 存在）时才查：没选 web 的实例不该因此亮灯
  const webPlist = `${HOME}/Library/LaunchAgents/com.claudestra.web.plist`;
  const labels = ["com.claudestra.bridge", "com.claudestra.launcher", "com.claudestra.cron",
    ...(existsSync(webPlist) ? ["com.claudestra.web"] : [])];
  for (const label of labels) {
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
    const logFile = resolveLogPath(String(label.split(".").pop()), "err");
    out.push({
      group: g, name: label, status: v.status, detail: v.detail,
      fix: v.status === "fail"
        ? `launchctl kickstart -k gui/$(id -u)/${label}，起不来就看日志 ${logFile}`
        : v.status === "warn" ? `看日志 ${logFile}` : undefined,
    });
  }
  return out;
}

/**
 * v2.17.2 端口属主校验(peer 实报:遗留 pm2 bridge 抢占 3847,launchd 份 10s 一轮
 * 崩溃重启 12908 次,而 `manager update` 只 reload launchd——真正在服务的进程
 * 永远收不到更新,修复静默不生效)。listener 与 launchd 托管 pid 必须是同一个。
 * 返回 null = 数据不足不下结论(无 listener 已有专门 fail)。
 */
export function portOwnerVerdict(
  listenerPid: string | null,
  launchdPid: string | null,
): { status: CheckStatus; detail: string } | null {
  if (!listenerPid) return null;
  if (!launchdPid) {
    return {
      status: "fail",
      detail: `端口被 pid ${listenerPid} 持有,但 launchd 托管的 bridge 没在跑——被别的托管方式(pm2 遗留?)抢占,update 重载不会重启真正在服务的进程`,
    };
  }
  if (listenerPid !== launchdPid) {
    return {
      status: "fail",
      detail: `端口持有者 pid ${listenerPid} ≠ launchd 托管 pid ${launchdPid}——双托管冲突(pm2 遗留?),update 重载不会重启真正在服务的进程`,
    };
  }
  return { status: "ok", detail: `端口由 launchd 托管进程持有(pid ${listenerPid})` };
}

async function checkBridge(repoRoot: string): Promise<Check[]> {
  const out: Check[] = [];
  const g = "bridge";
  // 与 Bun 加载 .env 同一口径（带引号的 BRIDGE_PORT 以前会被误读成默认端口 → 误诊）
  const dotenvFile = readDotenvFileSync(`${repoRoot}/.env`);
  const dotenv = dotenvFile ?? {};
  const port = resolveBridgePort(dotenv);

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

  // 属主校验:listener pid 必须就是 launchd 托管的那个(双托管冲突自曝,peer 建议)
  if (listeners.length >= 1 && process.platform === "darwin") {
    const listenerPid = (listeners[0]!.trim().split(/\s+/)[1] || "").trim() || null;
    const lc = await sh(["launchctl", "list"]);
    const bline = lc.out.split("\n").find((l) => l.includes("com.claudestra.bridge"));
    const launchdPid = bline ? ((bline.split("\t")[0] || "").trim().replace(/^-$/, "") || null) : null;
    const v = portOwnerVerdict(listenerPid, launchdPid);
    if (v) {
      out.push({
        group: g, name: "端口属主", status: v.status, detail: v.detail,
        fix: v.status === "fail"
          ? "找出并停掉非 launchd 的那份(pm2 delete / kill),再 launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge"
          : undefined,
      });
    }
  }

  // BRIDGE_URL 显式指向了别的端口 → channel-server 会连到没人听的地方，
  // 症状是「bridge 完全健康，但所有 agent 永远离线」（2026-09-22 实锤）
  try {
    const { bridgeUrlPortMismatch } = await import("./bridge-url.js");
    if (!dotenvFile) throw new Error("no .env"); // 没有 .env：这组检查整体跳过（与原先 readFile 抛错时一致）
    const pick = (k: string) => dotenv[k] || undefined;
    const mismatch = bridgeUrlPortMismatch({ BRIDGE_URL: pick("BRIDGE_URL"), BRIDGE_PORT: pick("BRIDGE_PORT") });
    if (mismatch) {
      out.push({ group: g, name: "BRIDGE_URL 端口", status: "fail", detail: mismatch,
        fix: "把 .env 里的 BRIDGE_URL 删掉（会自动按 BRIDGE_PORT 推），或改成同一个端口" });
    }
    // tmux 全局环境停在 server 创建那一刻：与 .env 不一致 = 在跑的会话还连着旧地址
    const { resolveBridgeUrl } = await import("./bridge-url.js");
    const { bridgeDrift, parseTmuxEnvLine } = await import("./bridge-port.js");
    const tenv = await sh(["tmux", "-S", TMUX_SOCK, "show-environment", "-g"]);
    if (tenv.ok && tenv.out) {
      const drift = bridgeDrift(
        { BRIDGE_URL: parseTmuxEnvLine(tenv.out, "BRIDGE_URL"), BRIDGE_PORT: parseTmuxEnvLine(tenv.out, "BRIDGE_PORT") },
        resolveBridgeUrl({ BRIDGE_URL: pick("BRIDGE_URL"), BRIDGE_PORT: pick("BRIDGE_PORT") }),
      );
      out.push(drift
        ? { group: g, name: "会话连接地址", status: "fail",
            detail: `tmux 里的会话按 ${drift.from} 启动，.env 现在是 ${drift.to} —— 这些会话连不上 bridge`,
            fix: "launchctl kickstart -k gui/$(id -u)/com.claudestra.launcher（launcher 会在新 bridge 应答后重启全部会话）" }
        : { group: g, name: "会话连接地址", status: "ok", detail: "tmux 全局环境与 .env 一致" });
    }
  } catch { /* 没有 .env 就跳过 */ }

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(`http://127.0.0.1:${port}/stats`, { signal: ctl.signal });
    clearTimeout(timer);
    out.push(res.ok
      ? { group: g, name: "HTTP /stats", status: "ok", detail: `HTTP ${res.status}` }
      : { group: g, name: "HTTP /stats", status: "warn", detail: `HTTP ${res.status}`,
          fix: `看 ${resolveLogPath("bridge", "err")}` });
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
  // v2.21.5+ SessionStart 记忆召回 hook:本机有 recall.py 才有资格报 warn(mem0 是 owner 自己的设施)
  if (recallAvailable()) {
    let hooked = false;
    if (existsSync(settingsPath)) {
      try { hooked = hasRecallHook(JSON.parse(await readFile(settingsPath, "utf-8"))); } catch { hooked = false; }
    }
    out.push(hooked
      ? { group: g, name: "记忆召回 hook", status: "ok", detail: "SessionStart 已挂(startup/resume/clear/compact → recall.py + HANDOFF.md)" }
      : { group: g, name: "记忆召回 hook", status: "warn", detail: "本机有 ~/mem0-mcp/recall.py 但没挂 SessionStart hook —— 开会话不会自动注入 mem0 召回与 HANDOFF",
          fix: "bun src/manager.ts install-hooks" });
  }
  // v2.21.3+ 仓库 skill 有没有真的装进 ~/.claude/skills(MacBook 曾悬空两个月没人发现)
  for (const r of installRepoSkills(repoRoot, { apply: false })) {
    out.push(r.action === "ok"
      ? { group: g, name: `skill ${r.name}`, status: "ok", detail: r.detail }
      : { group: g, name: `skill ${r.name}`, status: "warn", detail: r.detail,
          fix: `bun ${repoRoot}/src/manager.ts install-skills` });
  }
  return out;
}

/**
 * 「registry 里有、tmux 里没有」的真·孤儿名单（纯函数，单测覆盖）。
 *
 * ⚠ 必须按 status 过滤：**stopped 的 agent 本来就没有 window**——那是「已停」的
 * 定义，不是异常。2026-09-21 体检里 13 个 2026-03 起陆续退役的 agent 被一直点名，
 * 把一条本该有意义的信号（「它自称 active，窗口却没了」= 掉线/被 kill/换了 session）
 * 变成了永久噪声。`manager.ts list` 的孤儿检测一直就是只看 active 的，这里对齐。
 *
 * ⚠ 大总管也要跳过：它的 window 名是裸 `master`（未定名的老窗口则是 claude / 版本号），
 * registry 的键却是 `agent-master`（见 registry.isMasterAgent），按名字比对必然对不上 ⇒ 恒判孤儿。
 */
export function orphanAgentNames(
  agents: Array<{ name: string; status?: string }>,
  windows: Set<string>,
): string[] {
  return agents
    .filter((a) => a.status === "active" && !isMasterAgent(a.name) && !windows.has(a.name))
    .map((a) => a.name);
}

async function checkAgents(): Promise<Check[]> {
  const out: Check[] = [];
  const g = "agent";

  let agents: Array<{ name: string; status?: string }> = [];
  try {
    agents = (await readRegistryAgents()).map((a) => ({ name: a.name, status: a.status }));
  } catch (e) {
    out.push({ group: g, name: "registry.json", status: "fail", detail: `读不了：${(e as Error).message}`,
      fix: `检查 ${ORCH_DIR}/registry.json 是不是坏了（应是 JSON 对象）` });
    return out;
  }
  out.push({ group: g, name: "registry.json", status: "ok", detail: `${agents.length} 个 agent` });

  const sock = TMUX_SOCK;
  const win = await sh(["tmux", "-S", sock, "list-windows", "-t", "master", "-F", "#{window_name}"]);
  if (!win.ok) {
    out.push({ group: g, name: "master tmux session", status: agents.length > 0 ? "fail" : "warn",
      detail: "不存在 —— 所有 agent 都不在跑",
      fix: "launchctl kickstart -k gui/$(id -u)/com.claudestra.launcher（launcher 负责把 master session 拉起来）" });
    return out;
  }
  const windows = new Set(win.out.split("\n").map((s) => s.trim()).filter(Boolean));
  const missing = orphanAgentNames(agents, windows);
  const active = agents.filter((a) => a.status === "active").length;
  out.push(missing.length === 0
    ? { group: g, name: "tmux window", status: "ok",
        // 私有 socket：普通 `tmux ls` 看不到这些会话，把能看到的命令直接给出来
        detail: `${windows.size} 个 window，${active} 个 active agent 都在（查看：tmux -S ${sock} ls，或 claudestra ls）` }
    : { group: g, name: "tmux window", status: "warn", detail: `registry 说 active 但 tmux 里没有：${missing.join(", ")}`,
        fix: `bun src/manager.ts restart <name> 重新拉起，或 bun src/manager.ts remove <name> 清掉登记` });
  return out;
}

/** web 构建时效判定：与 install-cli 的自动重建共用同一判据（按 hash，见 lib/web-build.ts） */
export { webBuildVerdict } from "./web-build.js";

/** v2.16.3 detached HEAD 检查(HedeMacBook-Pro 报告:老版 update checkout tag
 *  会把仓库留在 no branch,本地分支冻结、自动更新看似正常实则失灵)。 */
async function checkGitHead(repoRoot: string): Promise<Check[]> {
  try {
    const p = Bun.spawn(["git", "symbolic-ref", "-q", "HEAD"], { cwd: repoRoot, stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(p.stdout).text()).trim();
    await p.exited;
    if (p.exitCode === 0 && out) {
      return [{ group: "config", name: "git HEAD", status: "ok", detail: `在分支 ${out.replace("refs/heads/", "")} 上` }];
    }
    return [{
      group: "config",
      name: "git HEAD",
      status: "warn",
      detail: "仓库处于 detached HEAD(no branch)——本地分支不再前进,版本冻结类故障温床",
      fix: "git checkout main && git merge --ff-only <当前版本 tag>(有分叉先看 git log 再决定)",
    }];
  } catch {
    return [];
  }
}

/** v2.20.2+ 脏工作区 = 自动更新静默阻塞(peer 实报:用户微调软链进仓库的 skill
 *  → git pull 失败 → 版本停在旧的,三周没人发现)。这里把因果挑明。 */
async function checkWorktreeClean(repoRoot: string): Promise<Check[]> {
  try {
    const p = Bun.spawn(["git", "status", "--porcelain"], { cwd: repoRoot, stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(p.stdout).text()).trim();
    await p.exited;
    if (p.exitCode !== 0) return [];
    if (!out) {
      return [{ group: "config", name: "工作区", status: "ok", detail: "干净(自动更新可正常前进)" }];
    }
    // porcelain 行是「XY<空格>路径」,但整体 trim 会吃掉首行的前导空格——按正则剥状态段,别数下标
    const files = out.split("\n").map((l) => l.replace(/^\s*\S+\s+/, "")).slice(0, 3).join(", ");
    const n = out.split("\n").length;
    return [{
      group: "config",
      name: "工作区",
      status: "warn",
      detail: `有 ${n} 处未提交改动(${files}${n > 3 ? " …" : ""})——**自动更新已阻塞**,git pull 会一直失败`,
      fix: "改动是自己要的就 commit;是误改(如微调了软链进仓库的 skill)就 git checkout -- <file>;想改 skill 又不想动仓库,把软链换成复制",
    }];
  } catch {
    return [];
  }
}

/**
 * Web 端登录的硬前置：本机 sshd。
 *
 * 网页用**本机系统账号**登录 —— 后端拿用户名密码去 SSH `127.0.0.1:22`（等价 PAM，
 * 见 web/lib/services/auth.service.ts）。而 macOS 的「远程登录」**默认是关的**，
 * 关着就没人听 22 端口，于是密码再对也一律登录失败，页面只说「用户名或密码错误」
 * ——人会去反复试密码，根本想不到是系统设置。2026-09-22 试装到这一步才发现
 * setup 和 doctor 都没查过它。
 *
 * ⚠ 探法用 `nc -z` 而不是 `lsof -iTCP:22`：sshd 的监听套接字属 root，普通用户的
 * lsof 看不见它，会得到「没人监听」的假阴性（本机实测）。
 */
export async function checkWebLogin(repoRoot: string): Promise<Check[]> {
  if (!existsSync(`${repoRoot}/web/.env.local`)) return []; // 没配 web 的实例不出这条
  const r = await sh(["nc", "-z", "-G", "2", "127.0.0.1", "22"]);
  return [r.ok
    ? { group: "web", name: "登录(本机 SSH)", status: "ok", detail: "sshd 在听 22 —— 用本机系统账号的用户名密码登录" }
    : {
        group: "web",
        name: "登录(本机 SSH)",
        status: "fail",
        detail: "22 端口没人听 —— 网页登录一定失败(它拿账号密码验本机 SSH)，且页面只会说「密码错误」",
        fix: "打开「系统设置 → 通用 → 共享 → 远程登录」；命令行: sudo systemsetup -setremotelogin on",
      }];
}

async function checkWebBuild(repoRoot: string): Promise<Check[]> {
  if (!existsSync(`${repoRoot}/web/node_modules`)) return []; // 未装 web 的实例不出这条
  const { readWebBuildFacts, webBuildVerdict } = await import("./web-build.js");
  const v = webBuildVerdict(readWebBuildFacts(repoRoot));
  return [{
    group: "web",
    name: "构建产物时效",
    status: v.status,
    detail: v.detail,
    // manager update 在已是最新时不会构建；install-cli 每次都按同一判据检查并重建
    ...(v.status !== "ok" ? { fix: "bun src/manager.ts install-cli" } : {}),
  } as Check, ...(await checkWebPort(repoRoot))];
}

/** web 端口：有没有人听、听的是不是 launchd 托管的那份（常见开发端口被占时服务会崩溃循环） */
async function checkWebPort(repoRoot: string): Promise<Check[]> {
  if (process.platform !== "darwin" || !existsSync(`${HOME}/Library/LaunchAgents/com.claudestra.web.plist`)) return [];
  const { webPortFromStartScript, listenersOf, launchdPidOf, portOwnerConflict } = await import("./cli-install.js");
  let start: string | undefined;
  try { start = JSON.parse(await readFile(`${repoRoot}/web/package.json`, "utf-8"))?.scripts?.start; } catch { /* 用默认端口 */ }
  const port = webPortFromStartScript(start);
  const listeners = listenersOf(port);
  if (listeners.length === 0) {
    return [{ group: "web", name: `端口 ${port}`, status: "fail", detail: "没有进程在监听 —— 网页打不开",
      fix: `看日志 ${resolveLogPath("web", "err")}，再 launchctl kickstart -k gui/$(id -u)/com.claudestra.web` }];
  }
  const conflict = portOwnerConflict(listeners, launchdPidOf("com.claudestra.web"));
  return [conflict
    ? { group: "web", name: `端口 ${port}`, status: "fail", detail: conflict,
        fix: `lsof -nP -iTCP:${port} -sTCP:LISTEN 找出占用者并停掉，再 launchctl kickstart -k gui/$(id -u)/com.claudestra.web` }
    : { group: "web", name: `端口 ${port}`, status: "ok", detail: `由 launchd 托管进程监听（pid ${listeners[0]!.pid}）` }];
}

// ────────────────────────────────────────────
// 入口
// ────────────────────────────────────────────


/**
 * v2.19.0 部署归属体检（2026-08-15 双响事故的产物）。
 *
 * 三项，全是那晚花两小时才手工查明白的东西：
 *  1. 本机是不是这套状态目录的主 —— 副本自启会拿着别人的 registry 干活；
 *  2. 日志写得进去吗、在哪 —— 那晚 stderr 被 /tmp 清理删掉了，排障时看不见；
 *  3. 备份心跳（可选）—— 有 standby-heartbeat 文件才检查，多久没更新了。
 */
async function checkDeployment(): Promise<Check[]> {
  const out: Check[] = [];
  const G = "部署归属";

  // ① 认主
  try {
    const { readOwnerMarker, ownerVerdict, machineUuid } = await import("./owner-guard.js");
    const { hostname } = await import("os");
    const marker = readOwnerMarker();
    const self = { uuid: machineUuid(), host: hostname() };
    if (!marker) {
      out.push({ group: G, name: "主机标记", status: "warn",
        detail: "还没有 owner.json（下次 daemon 启动会自动登记本机）",
        fix: "启动任一 daemon 即可生成；或 bun src/manager.ts doctor 后重启 bridge" });
    } else {
      const v = ownerVerdict(marker, self, false);
      out.push(v.ok
        ? { group: G, name: "主机标记", status: "ok", detail: `本机是主（${marker.host}）` }
        : { group: G, name: "主机标记", status: "fail",
            detail: `本机不是主：标记指向 ${marker.host}（写于 ${marker.at}），本机是 ${self.host}`,
            fix: "这台多半是备份/还原出来的副本。守护进程会拒绝启动。要正式接管：先停主机，再带 CLAUDESTRA_TAKEOVER=1 启动" });
    }
  } catch (e) {
    out.push({ group: G, name: "主机标记", status: "warn", detail: `读不出来: ${(e as Error).message}` });
  }

  // ② 日志落点
  try {
    const { LOG_DIR, logPath, legacyLogPath } = await import("./log-paths.js");
    const newP = logPath("bridge", "err");
    if (existsSync(newP)) {
      out.push({ group: G, name: "日志落点", status: "ok", detail: `${LOG_DIR}（不受 /tmp 清理影响）` });
    } else if (existsSync(legacyLogPath("bridge", "err"))) {
      out.push({ group: G, name: "日志落点", status: "warn",
        detail: "仍写在 /tmp —— macOS 会定期清理它，进程还开着 fd 时日志会静默消失",
        fix: "bun src/manager.ts install-cli 重写 plist 后重启 daemon" });
    } else {
      out.push({ group: G, name: "日志落点", status: "warn", detail: "找不到 bridge 日志（daemon 没跑过？）" });
    }
  } catch (e) {
    out.push({ group: G, name: "日志落点", status: "warn", detail: (e as Error).message });
  }

  // ③ 备份心跳（可选：文件不存在就不报，避免给没做备份的人凭空加告警）
  try {
    const hb = `${ORCH_DIR}/standby-heartbeat`;
    if (existsSync(hb)) {
      const ageH = (Date.now() - statSync(hb).mtimeMs) / 3600_000;
      out.push(ageH < 24
        ? { group: G, name: "备份心跳", status: "ok", detail: `${ageH.toFixed(1)} 小时前同步过` }
        : { group: G, name: "备份心跳", status: "warn",
            detail: `备份已 ${Math.round(ageH)} 小时没成功过（心跳文件停在 ${new Date(statSync(hb).mtimeMs).toISOString()}）`,
            fix: "去备份端看拉取日志——静默失败的备份等于没有备份" });
    }
  } catch { /* 可选项，读不到就跳过 */ }

  return out;
}

/**
 * notify 投递失败会追加到 undelivered-alerts.log（lib/notify）。以前没人读它——告警没送达
 * 这件事本身也没送达。有条目就 warn；文件不存在 / 为空不出这一行（健康实例输出不变）。
 * 纯函数，tests/doctor.test.ts。
 */
export function undeliveredAlertsVerdict(text: string | null, path: string, now = Date.now()): Check | null {
  if (!text) return null;
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;
  let last: { ts?: string; source?: string; reason?: string } = {};
  try { last = JSON.parse(lines[lines.length - 1]!); } catch { /* 坏行：只报条数 */ }
  const WEEK = 7 * 24 * 3600 * 1000;
  const recent = lines.filter((l) => {
    try {
      const t = Date.parse(JSON.parse(l).ts);
      return Number.isFinite(t) && now - t < WEEK;
    } catch { return false; }
  }).length;
  const lastDesc = last.ts ? `；最近一条 ${last.ts}${last.source ? ` [${last.source}]` : ""}${last.reason ? `：${last.reason}` : ""}` : "";
  return {
    group: "告警投递", name: "未送达告警", status: "warn",
    detail: `${lines.length} 条（近 7 天 ${recent} 条）${lastDesc}`,
    fix: `看 ${path} 里没送到的告警内容；处理完后清空该文件（: > ${path}）`,
  };
}

async function checkUndeliveredAlerts(): Promise<Check[]> {
  const text = await readFile(UNDELIVERED_ALERTS_LOG, "utf-8").catch(() => null);
  const v = undeliveredAlertsVerdict(text, UNDELIVERED_ALERTS_LOG);
  return v ? [v] : [];
}

export async function runDoctor(repoRoot: string): Promise<Check[]> {
  const groups = await Promise.all([
    checkRuntime(),
    checkConfig(repoRoot),
    checkDaemons(),
    checkUndeliveredAlerts(),
    checkBridge(repoRoot),
    checkIntegration(repoRoot),
    checkAgents(),
    checkGitHead(repoRoot),
    checkWorktreeClean(repoRoot),
    checkWebBuild(repoRoot),
    checkWebLogin(repoRoot),
    checkDeployment(),
    import("./doctor-remote.js").then((m) => m.checkRemoteAccess(repoRoot)),
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
