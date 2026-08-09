/**
 * Master Session Launcher
 *
 * launchd 管理的守护进程（com.claudestra.launcher），确保大总管的 tmux session 始终存活。
 * 如果 session 死了自动重启。
 */

import { enableTimestampLogs } from "./lib/log-timestamp.js";
enableTimestampLogs(); // 给所有 console log 加 ISO timestamp 前缀（daemon 专用）

import { initLang, t } from "./lib/i18n.js";
initLang();

import {
  tmuxRaw,
  masterSessionExists,
  masterWindowExists,
  windowHasChildProcess,
  ensureSocketDir,
  isIdle as tmuxIsIdle,
  tmuxCapture,
  tmuxSendLine,
  isAutoConfirmableModal,
  detectSessionIdlePrompt,
  CC_MODE_BANNER_RE,
  listAgentWindows,
  windowTarget,
  clearShellInitPrompts,
  MASTER_SESSION as SESSION_NAME,
} from "./lib/tmux-helper.js";

/**
 * Master 专用：用 isAutoConfirmableModal 做几何识别 + 允许 session-idle 自动按。
 * agent 的 session-idle 由 manager.ts 的就绪轮询自动选「完整恢复」。
 */
function masterShouldAutoConfirm(pane: string): boolean {
  return isAutoConfirmableModal(pane, { allowSessionIdle: true });
}

/**
 * v2.0.22+: 自动确认 master 的弹窗。session-idle 弹窗特判 —— Enter 会选中高亮的
 * option 1 = 从摘要恢复 = compact 丢上下文，所以改 arrow nav 选 option 2「完整
 * 恢复」（Down 再 Enter）。普通确认弹窗仍直接 Enter。
 */
async function confirmMasterModal(pane: string): Promise<void> {
  if (detectSessionIdlePrompt(pane)) {
    await tmuxRaw(["send-keys", "-t", MASTER_WINDOW, "Down"]);
    await Bun.sleep(150);
    await tmuxRaw(["send-keys", "-t", MASTER_WINDOW, "Enter"]);
  } else {
    await tmuxRaw(["send-keys", "-t", MASTER_WINDOW, "Enter"]);
  }
}
import { buildClaudeCommand } from "./lib/claude-launch.js";
import { resolveNpm } from "./lib/npm-path.js";
import { bridgeRequest } from "./lib/bridge-client.js";
import { readConfig } from "./lib/config-store.js";
import { installCrashGuard } from "./lib/crash-guard.js";

// 进程级异常兜底：保证死因一定进 stderr（见 lib/crash-guard.ts）
installCrashGuard("launcher");


// 默认 master 目录：仓库根 / master。允许 env 覆盖以支持自定义部署。
const MASTER_DIR = process.env.MASTER_DIR || `${import.meta.dir}/../master`;
const REPO_ROOT = `${import.meta.dir}/..`;
const CONTROL_CHANNEL_ID = process.env.CONTROL_CHANNEL_ID || "";
const BRIDGE_URL = process.env.BRIDGE_URL || "ws://localhost:3847";
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "").split(",").filter(Boolean);
const CHECK_INTERVAL_MS = 15_000; // 每 15 秒检查一次
const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000; // 每 30 分钟检查一次 Claudestra 新版本
const CLAUDE_UPDATE_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60_000; // 每 1 周检查一次 Claude Code 更新
const DEAD_AGENT_CHECK_INTERVAL_MS = 60_000; // 每 1 分钟扫一次 dead agent 自愈

if (!CONTROL_CHANNEL_ID) {
  console.error("❌ 请设置 CONTROL_CHANNEL_ID（Discord #control 频道 ID）");
  process.exit(1);
}

const MASTER_WINDOW = `${SESSION_NAME}:0`;

async function sessionExists(): Promise<boolean> {
  return masterSessionExists();
}

async function isIdle(): Promise<boolean> {
  return tmuxIsIdle(MASTER_WINDOW);
}

async function captureLast(lines = 10): Promise<string> {
  return tmuxCapture(MASTER_WINDOW, lines);
}

/**
 * master 的 session-scoped effort（通过 `--effort <level>` CLI flag 传给 Claude Code）。
 *
 * master 绝大多数 turn 是路由调度，low 就够了、响应更快、token 更省。
 * 这个设置只影响 master 这一个 Claude Code 进程，agent 不传 `--effort` →
 * 继承全局 `~/.claude/settings.json` 的 effortLevel（通常是 xhigh/max）。
 *
 * 用 env MASTER_EFFORT=<level> 覆盖。`default` 或空字符串 → 不加 flag，
 * master 也跟着全局 effortLevel 走。
 */
const MASTER_EFFORT = (process.env.MASTER_EFFORT || "low").trim();

/**
 * 在 master:0 窗口里启动 Claude Code 并等它就绪。
 * 假定 session 已存在、window:0 已存在（或调用方保证会被创建）。
 */
async function bringUpClaudeInMasterWindow(): Promise<boolean> {
  const cmd = buildClaudeCommand({
    channelId: CONTROL_CHANNEL_ID,
    bridgeUrl: BRIDGE_URL,
    effort: MASTER_EFFORT,
  });
  // shell init 阶段的 Y/n（oh-my-zsh / homebrew）会吞掉首字符，先清掉。
  await clearShellInitPrompts(MASTER_WINDOW);
  await tmuxSendLine(MASTER_WINDOW, cmd);

  // 等待并自动确认各种提示（dev channel、trust、bypass、etc）
  for (let i = 0; i < 120; i++) {
    await Bun.sleep(500);
    const pane = await captureLast(10);

    if (await isIdle()) {
      console.log(`✅ 大总管已就绪${MASTER_EFFORT && MASTER_EFFORT !== "default" ? `（effort=${MASTER_EFFORT}）` : ""}`);
      return true;
    }

    if (masterShouldAutoConfirm(pane)) {
      await confirmMasterModal(pane);
      await Bun.sleep(500);
      continue;
    }
  }

  console.log("⚠️ 大总管启动超时，但 window 可能仍在初始化");
  return await masterWindowExists();
}

async function startMaster() {
  console.log("🚀 启动大总管 session...");

  // 确保 socket 目录存在
  await ensureSocketDir();

  // 创建 tmux session；base-index=0 显式设一下，防止私有 socket 的 tmux
  // server 意外继承到非 0 的 base-index（-f /dev/null 在 tmuxRaw 已经处理，
  // 这里是 belt-and-suspenders）。
  await tmuxRaw(["new-session", "-d", "-s", SESSION_NAME, "-c", MASTER_DIR]);
  await tmuxRaw(["set-option", "-t", SESSION_NAME, "base-index", "0"]).catch(() => {});
  await Bun.sleep(500);

  return bringUpClaudeInMasterWindow();
}

/**
 * Session 存在但 window:0 丢了（罕见但可能：用户手动 kill-window 或 pm2 重启
 * 时序问题）。这个 helper 负责补一个 window:0 回来，然后在里面起 Claude。
 */
async function recoverMasterWindow(): Promise<boolean> {
  console.log("🔧 master session 存在但 window:0 丢了，重建 window:0...");
  await tmuxRaw(["new-window", "-t", SESSION_NAME, "-k", "-c", MASTER_DIR]);
  await Bun.sleep(500);
  // 上面的 new-window 不带 index，会按 base-index 自动分配；强制挪到 0
  await tmuxRaw(["move-window", "-s", SESSION_NAME, "-t", MASTER_WINDOW]).catch(() => {});
  await Bun.sleep(200);
  if (!(await masterWindowExists())) {
    console.log("⚠️ 创建 window:0 失败");
    return false;
  }
  return bringUpClaudeInMasterWindow();
}

// ============================================================
// 版本更新检查
// ============================================================

let lastUpdateCheck = 0;
let lastNotifiedVersion = "";
// v2.17.2 beta apply 重试状态(失败的 SHA 不再一次性放弃)+ 子进程日志落点
let lastBetaAttemptSha = "";
let lastBetaAttemptAt = 0;
const BETA_UPDATE_LOG = "/tmp/claudestra-beta-update.log";

/** v2.17 beta 通道轮询:比对 HEAD vs origin/main,落后且全员空闲即触发
 *  manager update(其内部走 beta 前进流程)。 */
async function checkBetaUpdates(autoOn: boolean) {
  const g = async (...a: string[]) => {
    const p = Bun.spawn(["git", "-C", REPO_ROOT, ...a], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(p.stdout).text()).trim();
    await p.exited;
    return p.exitCode === 0 ? out : "";
  };
  await g("fetch", "--quiet", "origin", "main");
  const head = await g("rev-parse", "HEAD");
  const remote = await g("rev-parse", "origin/main");
  if (!head || !remote || head === remote) return;
  if (!autoOn) {
    // 通知去重只属于「自动更新关着」的提示路径;auto 路径的重试节流在下面
    // 单独管(v2.17.2:此前这道门也拦 auto 路径,通知过的 SHA 开了 auto 也不动)
    if (remote === lastNotifiedVersion) return;
    lastNotifiedVersion = remote;
    await bridgeRequest({
      type: "reply", chatId: CONTROL_CHANNEL_ID,
      text: `🧪 beta 通道有新 commit(${head.slice(0, 7)} → ${remote.slice(0, 7)}),自动更新已关——手动: bun src/manager.ts update`,
    }).catch(() => {});
    return;
  }
  if (!(await allAgentsIdle())) {
    console.log(`🧪 beta 有新 commit(${remote.slice(0, 7)}),有 agent 在忙,下次再试`);
    return;
  }
  // v2.17.2(peer 报告「beta 只 pull 不 apply,形同虚设」的两个真凶):
  // ① 旧代码把 remote SHA 记进 lastNotifiedVersion=「已处理」——update 子进程
  //    若在早期 bail(update.lock 未过期/脏树/网络),这个 SHA 永不重试,beta 卡死
  //    到下一个 commit 出现。改为攻击性重试:HEAD 没追平就每轮(带 10 分钟冷却)
  //    再试;成功路径会 reload launcher 本体,状态自然清零。
  // ② 子进程输出全 ignore——bail 无任何痕迹。改为追加到日志文件,失败可见。
  if (remote === lastBetaAttemptSha && Date.now() - lastBetaAttemptAt < 10 * 60_000) return;
  lastBetaAttemptSha = remote;
  lastBetaAttemptAt = Date.now();
  console.log(`🧪 beta 自动前进 ${head.slice(0, 7)} → ${remote.slice(0, 7)}(结果见 ${BETA_UPDATE_LOG})`);
  const stamp = `\n[${new Date().toISOString()}] 🧪 beta ${head.slice(0, 7)} → ${remote.slice(0, 7)}\n`;
  await import("fs/promises").then((m) => m.appendFile(BETA_UPDATE_LOG, stamp)).catch(() => {});
  Bun.spawn(["bash", "-c", `exec "${process.execPath}" run "${REPO_ROOT}/src/manager.ts" update >> "${BETA_UPDATE_LOG}" 2>&1`], {
    cwd: REPO_ROOT, stdin: "ignore", stdout: "ignore", stderr: "ignore",
    // @ts-ignore Bun 支持 detached
    detached: true,
  });
}

async function checkForUpdates() {
  if (!CONTROL_CHANNEL_ID) return;

  // v2.17 通道分流:beta 跟 commit,release 跟正式版
  {
    const cfgChan = await readConfig();
    if ((cfgChan.autoUpdate.channel ?? "release") === "beta") {
      await checkBetaUpdates(cfgChan.autoUpdate.claudestra);
      return;
    }
  }

  const { getLatestRelease, getLocalVersion, isNewer } = await import("./lib/github-release.js");

  const release = await getLatestRelease();
  if (!release) return;

  const local = await getLocalVersion();
  if (!isNewer(release.version, local)) return;
  if (release.version === lastNotifiedVersion) return;
  lastNotifiedVersion = release.version;

  const cfg = await readConfig();

  if (!cfg.autoUpdate.claudestra) {
    // 关闭自动更新 → 只通知
    try {
      await bridgeRequest({
        type: "reply",
        chatId: CONTROL_CHANNEL_ID,
        text: [
          t(
            `🆕 **Claudestra ${release.tag} 发布了！** ${ALLOWED_USER_IDS.map(id => `<@${id}>`).join(" ")}`,
            `🆕 **Claudestra ${release.tag} has been released!** ${ALLOWED_USER_IDS.map(id => `<@${id}>`).join(" ")}`,
          ),
          ``,
          t(`当前: v${local} → 最新: ${release.tag}`, `Current: v${local} → Latest: ${release.tag}`),
          release.body ? `\n${release.body.slice(0, 500)}` : "",
          ``,
          t(
            `自动更新已关闭。更新命令: \`bun src/manager.ts update\``,
            `Auto-update is disabled. Update command: \`bun src/manager.ts update\``,
          ),
          t(
            `（开启自动更新: \`bun src/manager.ts auto-update claudestra on\`）`,
            `(Enable auto-update: \`bun src/manager.ts auto-update claudestra on\`)`,
          ),
        ].filter(Boolean).join("\n"),
      });
      console.log(`📢 已通知用户：新版本 ${release.tag}（自动更新 off）`);
    } catch {
      console.log("⚠️ 版本通知发送失败（bridge 可能还没就绪）");
    }
    return;
  }

  // 自动更新开启 → 等所有 agent 空闲再更新
  if (!(await allAgentsIdle())) {
    console.log(`🆙 Claudestra ${release.tag} 有新版本，但有 agent 在忙，下次再试`);
    lastNotifiedVersion = ""; // 让下次 poll 重新进入这个分支
    return;
  }

  console.log(`🆙 Claudestra ${release.tag} 自动更新开始（所有 agent 空闲）`);
  const mention = ALLOWED_USER_IDS.map((id) => `<@${id}>`).join(" ");
  try {
    await bridgeRequest({
      type: "reply",
      chatId: CONTROL_CHANNEL_ID,
      text: t(
        `🆕 **Claudestra ${release.tag} 自动更新中** ${mention}\n\nv${local} → ${release.tag}，所有 agent 当前空闲，开始 git pull + 重载 launchd daemon...`,
        `🆕 **Claudestra ${release.tag} auto-updating** ${mention}\n\nv${local} → ${release.tag}, all agents idle, running git pull + reloading the launchd daemons...`,
      ),
    });
  } catch { /* non-critical */ }

  // 关键：manager.ts update 会执行 pm2 restart，会杀掉本 launcher 自己
  // 用 detached + 重定向 stdio 让子进程脱离 launcher 生命周期
  Bun.spawn(
    ["bun", "run", `${REPO_ROOT}/src/manager.ts`, "update"],
    {
      cwd: REPO_ROOT,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      // @ts-ignore Bun 支持 detached
      detached: true,
    }
  );
  // 不 await exited — pm2 会马上杀掉我们；新 launcher 进程启动后通过 github-release 判断已是最新版
}

// ============================================================
// Claude Code 版本自动更新
// ============================================================

let lastClaudeUpdateCheck = 0;
// 初值取启动时刻(不是 0):否则主循环第一圈 `Date.now() - 0 >= 60_000` 恒真,
// periodic dead-agent 巡检开机即触发,和 boot restore 撞车(P1,peer 2026-08-09)。
let lastDeadAgentCheck = Date.now();

async function runCmd(cmd: string[], timeoutMs = 0): Promise<{ ok: boolean; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  // 可选超时强杀:坏掉的 claude 二进制连 --version 都永久 hang(2026-07-24),
  // 无超时的 runCmd 会把 launcher 主循环整个吊死
  const killer = timeoutMs > 0 ? setTimeout(() => { try { proc.kill(9); } catch { /* 已退出 */ } }, timeoutMs) : null;
  // stderr 必须一并读走:brew 等工具的报错全走 stderr,不读的话失败日志是空的
  // (2026-07-27「brew 更新失败:」后面什么都没有),大管道还会背压死锁
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  if (killer) clearTimeout(killer);
  return { ok: proc.exitCode === 0, out: out.trim(), err: err.trim() };
}

async function getClaudeVersion(): Promise<string | null> {
  const { ok, out } = await runCmd(["claude", "--version"], 20_000);
  if (!ok) return null;
  const m = out.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/**
 * 2026-07-24 事故 SOP:cask 升级后的新二进制带 com.apple.quarantine,Gatekeeper
 * 首扫评估在本机挂死(进程钉死在 dyld,连 --version 都不返回);更险的是该路径
 * 的评估缓存会被钉住——去掉 quarantine 后原路径依然挂,同内容拷到新路径立好。
 * 升级后必须先体检可执行性,坏了按 SOP 自动修:①去 quarantine ②旁路副本+改
 * symlink;都修不好则中止 agent 重启波(带着坏二进制重启=全灭,僵尸命令行
 * 卡满所有窗口)。
 */
async function verifyClaudeLaunchable(): Promise<{ ok: boolean; fixed?: string }> {
  const probe = async () => (await runCmd(["claude", "--version"], 20_000)).ok;
  if (await probe()) return { ok: true };
  try {
    const real = (await runCmd(["readlink", "-f", "/opt/homebrew/bin/claude"])).out.trim();
    if (real) {
      await runCmd(["xattr", "-d", "com.apple.quarantine", real]);
      if (await probe()) return { ok: true, fixed: "去 quarantine" };
      const side = `${real}2`;
      await runCmd(["cp", real, side]);
      await runCmd(["chmod", "+x", side]);
      await runCmd(["ln", "-sf", side, "/opt/homebrew/bin/claude"]);
      if (await probe()) return { ok: true, fixed: "旁路副本+symlink" };
    }
  } catch { /* 修复失败落到 not ok */ }
  return { ok: false };
}

async function getClaudeLatestVersion(): Promise<string | null> {
  // launchd 阉割 PATH 不含 nvm 目录,直接 spawn "npm" ENOENT(peer 2026-08-09:
  // 「CC 自动更新检查一直静默失败」,与 e11500e 修的 web 构建同坑)。复用
  // resolveNpm 解析绝对路径(src/lib/npm-path,manager 也用同一份)。
  const npmBin = resolveNpm();
  if (!npmBin) return null;
  const { ok, out } = await runCmd([npmBin.npm, "view", "@anthropic-ai/claude-code", "version"], 30_000);
  if (!ok) return null;
  const m = out.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/** claude 二进制的安装方式检测:realpath 落在 Homebrew Caskroom → brew cask
 *  (返回 cask 名);否则按 npm 全局处理。brew 装的机器上跑 npm install -g 必然
 *  EEXIST 失败——这正是「CC 静默更新老是失败」的根因(owner 2026-07-16)。 */
async function detectClaudeInstall(): Promise<{ kind: "brew"; cask: string } | { kind: "npm" }> {
  const which = await runCmd(["/bin/sh", "-lc", "realpath \"$(command -v claude)\" 2>/dev/null"]);
  const m = which.ok ? which.out.match(/\/Caskroom\/([^/]+)\//) : null;
  return m ? { kind: "brew", cask: m[1] } : { kind: "npm" };
}

/** 所有 agent + master 是否都空闲 */
async function allAgentsIdle(): Promise<boolean> {
  if (!(await tmuxIsIdle(MASTER_WINDOW))) return false;
  const agents = await listAgentWindows();
  for (const name of agents) {
    if (!(await tmuxIsIdle(windowTarget(name)))) return false;
  }
  return true;
}

/**
 * 扫 registry 找 "active 但 tmux window 丢了" 的 agent，对每个单独调
 * `manager.ts restart <name>` 让它 resume 回来。
 *
 * 这个函数设计成可以周期性调用 —— 没有 dead 就是 no-op，有 dead 就每个
 * 单独 restart（不churn 健康的 agent）。
 *
 * 参数 `source`: "boot"（开机首次自检）或 "periodic"（主循环定期检查）—
 * 前者有 dead 时才 notify master 频道；后者静默处理，避免刷屏。
 */
/**
 * 升级波 / 恢复波进行中标志（租约）。restoreDeadAgents 的 periodic 巡检必须在
 * 波内停手：波会依次 kill/重建每个 agent 的窗口，巡检在窗口空档扫到「dead」
 * 就并发再发一次 restart——两个 restart 各建一个同名窗口、抢同一个 --resume
 * session，双双失败（2026-07-27 实锤：ld-binance-operate 双窗口 + 整夜假「工作
 * 中」）。用「租约」而非布尔量：中途异常也不会把巡检永久锁死，租约到点自然恢复。
 *
 * v2.17.2（peer 2026-08-09 P1）：开机波（boot restore）此前不持租约,而 periodic
 * 的门槛 `Date.now() >= restartWaveUntil` 初值 0 恒过 → 开机时 boot 与 periodic
 * 各把 7 个 agent restart 一遍。修:boot restore 也持租约(下方)。
 */
let restartWaveUntil = 0;

async function restoreDeadAgents(source: "boot" | "periodic" = "boot") {
  try {
    const list = await runCmd(["bun", "run", `${REPO_ROOT}/src/manager.ts`, "list"]);
    if (!list.ok) return;
    const parsed = JSON.parse(list.out || "{}");
    const agents: any[] = parsed.agents || [];
    // manager.ts list 会把 "registry active 但 window 丢了" 的标为 status="dead"
    const reallyDead = agents.filter((a) => a.status === "dead");
    if (reallyDead.length === 0) {
      if (source === "boot") console.log("🔁 开机自检：没有需要恢复的 dead agent");
      return;
    }
    // 持租约压住 periodic 巡检——不论 boot 还是 periodic 先到,先到者拿租约,
    // 后到者被 685 的 `>= restartWaveUntil` 门槛挡住,不再撞车重启同一批(P1)
    restartWaveUntil = Date.now() + 10 * 60_000;
    console.log(`🔁 [${source}] 发现 ${reallyDead.length} 个 dead agent：${reallyDead.map((a: any) => a.name).join(", ")}`);
    if (source === "boot") {
      try {
        await bridgeRequest({
          type: "reply",
          chatId: CONTROL_CHANNEL_ID,
          text: t(
            `🔁 检测到 ${reallyDead.length} 个 agent 需要开机后恢复：${reallyDead.map((a: any) => `\`${a.name}\``).join(" / ")}\n正在 resume 它们的历史会话，几十秒内会陆续回到原频道。`,
            `🔁 Detected ${reallyDead.length} agent(s) need to be restored after boot: ${reallyDead.map((a: any) => `\`${a.name}\``).join(" / ")}\nResuming their sessions — they'll return to their original channels within ~1 min.`,
          ),
        });
      } catch { /* non-critical */ }
    }
    // 对每个 dead agent 单独调 restart <name>，不 churn 健康的 agent
    for (const agent of reallyDead) {
      console.log(`🔁 [${source}] 重启 ${agent.name}...`);
      await runCmd(["bun", "run", `${REPO_ROOT}/src/manager.ts`, "restart", agent.name]);
    }
    restartWaveUntil = Date.now() + 60_000; // 收尾:留 1 分钟冷却让新窗口稳定再恢复巡检
    console.log(`🔁 [${source}] restart 调用完成`);
  } catch (e) {
    console.error(`🔁 [${source}] 自检失败:`, e);
  }
}

async function restartAgentsAndMaster() {
  restartWaveUntil = Date.now() + 15 * 60_000; // 波开始:拿租约压住 dead-agent 巡检
  // 金丝雀先行(2026-07-24 事故:--version 体检过了不代表 TUI 真能起——先拿
  // 一个 agent 试全流程,ready 才放行其余;金丝雀失败立即中止+告警,别把
  // 全军带进僵尸态)。金丝雀选 registry 里第一个 active agent。
  try {
    const listOut = await runCmd(["bun", "run", `${REPO_ROOT}/src/manager.ts`, "list"], 30_000);
    const agents = (JSON.parse(listOut.out || "{}").agents || []) as { name: string; status?: string }[];
    const canary = agents.find((a) => a.status !== "stopped");
    if (canary) {
      const r = await runCmd(["bun", "run", `${REPO_ROOT}/src/manager.ts`, "restart", canary.name], 300_000);
      let canaryOk = false;
      try { canaryOk = JSON.parse(r.out || "{}").ok === true; } catch { /* 解析失败按失败算 */ }
      console.log(`🆙 金丝雀重启 ${canary.name}: ${canaryOk ? "✅" : "❌"}`);
      if (!canaryOk) {
        try {
          await bridgeRequest({
            type: "reply",
            chatId: CONTROL_CHANNEL_ID,
            text: t(
              `🚨 **升级后金丝雀重启失败**(${canary.name} 启动不了),已中止其余 agent 的重启波——它们继续跑旧进程。需人工排查新版 Claude Code ${ALLOWED_USER_IDS.map((id) => `<@${id}>`).join(" ")}`,
              `🚨 **Post-upgrade canary restart failed** (${canary.name} won't start). Remaining agents keep old processes. Manual investigation needed ${ALLOWED_USER_IDS.map((id) => `<@${id}>`).join(" ")}`,
            ),
          });
        } catch { /* non-critical */ }
        return;
      }
    }
  } catch (e) {
    console.log(`🆙 金丝雀流程异常(继续常规重启): ${(e as Error).message}`);
  }

  // 其余 agent 由 manager restart 处理（使用 registry 中的 sessionId + channelId）
  restartWaveUntil = Date.now() + 15 * 60_000; // 全量重启前续租(金丝雀可能耗掉数分钟)
  const { ok, out } = await runCmd(["bun", "run", `${REPO_ROOT}/src/manager.ts`, "restart"]);
  console.log(`🆙 bun manager restart 结果: ok=${ok}`);
  if (!ok) console.log(out);
  restartWaveUntil = Date.now() + 2 * 60_000; // 波收尾:留 2 分钟冷却后恢复巡检

  // master 通过发送 /exit 让其退出，主循环会自动重启
  await tmuxRaw(["send-keys", "-t", MASTER_WINDOW, "/exit", "Enter"]).catch(() => {});
}

async function checkClaudeCodeUpdate() {
  const cfg = await readConfig();
  if (!cfg.autoUpdate.claudeCode) return; // 开关关闭 → 跳过

  const current = await getClaudeVersion();
  if (!current) return;

  // 安装方式分流:brew cask 场景版本判断和升级都必须走 brew——npm 的 latest
  // 常领先 cask 几小时到几天,拿 npm 版本对比会永远误报「有更新」,而
  // npm install -g 对 brew 安装直接 EEXIST 失败(历史上「静默更新老失败」)。
  const install = await detectClaudeInstall();
  let latest: string;
  if (install.kind === "brew") {
    await runCmd(["brew", "update", "--quiet"]); // 刷新索引(weekly 一次,慢点无妨)
    // ⚠ brew outdated 对具名包的退出码语义:0=最新,**1=有更新**——exit 1 不是
    // 错误!老代码 `!outdated.ok` 把它当"没更新"提前 return,brew 安装下自动
    // 更新从未真正触发过(owner 2026-07-27「一次都没顺畅更新过」的根因)。
    // 改靠输出内容判定;--verbose 才带版本号("cask (2.1.218) != 2.1.220")。
    // brew 的报错走 stderr(runCmd 不收),真出错时 out 为空 → 按"已最新"安全跳过。
    const outdated = await runCmd(["brew", "outdated", "--cask", "--verbose", install.cask], 120_000);
    const line = outdated.out.trim();
    if (!line || !line.includes("!=")) return; // 空 = 已最新;没有 "!=" = 输出形态不认识,别硬升
    const m = line.match(/!=\s*(\S+)/);
    latest = m ? m[1] : "(brew 新版)";
  } else {
    const npmLatest = await getClaudeLatestVersion();
    if (!npmLatest) return;
    if (current === npmLatest) return;
    latest = npmLatest;
  }

  console.log(`🆙 Claude Code 有新版本: ${current} → ${latest} (${install.kind})`);

  // 等所有 agent 空闲再更新（避免打断正在进行的任务）
  if (!(await allAgentsIdle())) {
    // 「下次再试」如果按周期语义就是 7 天后——升级窗口稍纵即逝。把检查时间戳
    // 拨回去,30 分钟后重试,直到逮到全员空闲的窗口
    lastClaudeUpdateCheck = Date.now() - CLAUDE_UPDATE_CHECK_INTERVAL_MS + 30 * 60_000;
    console.log(`🆙 有 agent 在忙，30 分钟后重试`);
    return;
  }

  console.log(`🆙 所有 agent 空闲，开始更新 Claude Code`);
  try {
    const mention = ALLOWED_USER_IDS.map((id) => `<@${id}>`).join(" ");
    await bridgeRequest({
      type: "reply",
      chatId: CONTROL_CHANNEL_ID,
      text: t(
        `🆙 **Claude Code 新版本** ${current} → ${latest} ${mention}\n\n所有 agent 当前空闲，开始${install.kind === "brew" ? " brew upgrade" : " npm install"} + 重启...`,
        `🆙 **Claude Code update** ${current} → ${latest} ${mention}\n\nAll agents idle, running ${install.kind === "brew" ? "brew upgrade" : "npm install"} + restart...`,
      ),
    });
  } catch { /* non-critical */ }

  const upgrade =
    install.kind === "brew"
      ? // 不打 quarantine 标记:2026-07-24 事故根因——带 quarantine 的新二进制
        // 首次执行触发 Gatekeeper 评估,在本机挂死(dyld 阶段永久 hang)。
        // ⚠ `brew upgrade` 不认 --no-quarantine(那是 install 的 flag,直接
        // Error: invalid option 退出——2026-07-27 实测的「更新失败」真凶),
        // 正确姿势是 HOMEBREW_CASK_OPTS 环境变量,install/upgrade/reinstall 通吃。
        await runCmd(["env", "HOMEBREW_CASK_OPTS=--no-quarantine", "brew", "upgrade", "--cask", install.cask], 600_000)
      : await runCmd(["npm", "install", "-g", "@anthropic-ai/claude-code"], 600_000);
  if (!upgrade.ok) {
    console.log(`🆙 ${install.kind} 更新失败: ${upgrade.out}\n${upgrade.err}`);
    try {
      await bridgeRequest({
        type: "reply",
        chatId: CONTROL_CHANNEL_ID,
        text: t(
          `⚠️ Claude Code 更新失败（${install.kind === "brew" ? "brew upgrade" : "npm install"} 返回错误），详见 launcher 日志`,
          `⚠️ Claude Code update failed (${install.kind === "brew" ? "brew upgrade" : "npm install"} returned error) — see launcher logs`,
        ),
      });
    } catch { /* non-critical */ }
    return;
  }

  // 确认版本 + 可执行性体检(坏二进制绝不能进重启波,见 verifyClaudeLaunchable)
  const afterVersion = await getClaudeVersion();
  console.log(`🆙 Claude Code 已更新到 ${afterVersion}`);
  const health = await verifyClaudeLaunchable();
  if (!health.ok) {
    console.log(`🆙 ⚠️ 新二进制体检失败(启动挂死),中止 agent 重启波`);
    try {
      await bridgeRequest({
        type: "reply",
        chatId: CONTROL_CHANNEL_ID,
        text: t(
          `🚨 **Claude Code 升级后二进制无法启动**(--version 挂死,自动修复未成功)。已中止 agent 重启——现役 agent 继续跑旧进程不受影响,但新启动会挂。需人工处理:参照 web/SETUP.md 排障或回滚版本 ${ALLOWED_USER_IDS.map((id) => `<@${id}>`).join(" ")}`,
          `🚨 **Claude Code binary broken after upgrade** (--version hangs; auto-remediation failed). Agent restart wave aborted — running agents keep old processes, but new launches will hang. Manual action needed ${ALLOWED_USER_IDS.map((id) => `<@${id}>`).join(" ")}`,
        ),
      });
    } catch { /* non-critical */ }
    return;
  }
  if (health.fixed) {
    console.log(`🆙 新二进制体检:经「${health.fixed}」修复后可用`);
  }

  await restartAgentsAndMaster();

  try {
    await bridgeRequest({
      type: "reply",
      chatId: CONTROL_CHANNEL_ID,
      text: t(
        `✅ **Claude Code 更新完成** v${afterVersion}，所有 agent 已重启 ${ALLOWED_USER_IDS.map((id) => `<@${id}>`).join(" ")}`,
        `✅ **Claude Code updated** to v${afterVersion}, all agents restarted ${ALLOWED_USER_IDS.map((id) => `<@${id}>`).join(" ")}`,
      ),
    });
  } catch { /* non-critical */ }
}

// ============================================================
// 主循环
// ============================================================

async function main() {
  console.log(`📡 Launcher 启动`);
  console.log(`   session: ${SESSION_NAME}`);
  console.log(`   control channel: ${CONTROL_CHANNEL_ID}`);
  console.log(`   检查间隔: ${CHECK_INTERVAL_MS / 1000}s`);

  // 首次检查
  const masterWasAlreadyUp = await sessionExists();
  if (masterWasAlreadyUp) {
    console.log("✅ 大总管 session 已存在，进入监控模式");
  } else {
    await startMaster();
  }
  // v1.9.13+: 无论 master 之前在不在，都跑一次开机自检。之前只在 "master 不在"
  // 分支跑，导致 cmdUpdate 场景（pm2 restart launcher 时 tmux server 还活着，
  // session 依然 exists）下任何 registry active 但 window 丢了的 agent 不会被
  // 恢复 —— 用户看到的就是"Launcher 不拉"。
  setTimeout(() => restoreDeadAgents("boot").catch(() => {}), 3000);

  // 持续监控
  while (true) {
    await Bun.sleep(CHECK_INTERVAL_MS);

    if (!(await sessionExists())) {
      console.log("💀 大总管 tmux session 不存在，正在重启...");
      await startMaster();
      continue;
    }

    // session 活着但 window:0 可能没了（被手动 kill-window 或 tmux 异常）。
    // 这种情况 captureLast 会抓到隔壁 agent 的 pane 然后把 Enter 发去瞎戳，
    // 必须先补上 window:0。
    if (!(await masterWindowExists())) {
      console.log("💀 master:0 窗口不存在，正在恢复...");
      await recoverMasterWindow();
      continue;
    }

    // 检查是否卡在确认弹窗
    const pane = await captureLast(10);
    if (masterShouldAutoConfirm(pane)) {
      console.log("⚠️ 大总管卡在确认弹窗，自动确认...");
      await confirmMasterModal(pane);
    }

    // 定期检查 Claudestra 新版本（Release）
    if (Date.now() - lastUpdateCheck >= UPDATE_CHECK_INTERVAL_MS) {
      lastUpdateCheck = Date.now();
      checkForUpdates().catch(() => {});
    }

    // 定期检查 Claude Code 更新
    if (Date.now() - lastClaudeUpdateCheck >= CLAUDE_UPDATE_CHECK_INTERVAL_MS) {
      lastClaudeUpdateCheck = Date.now();
      checkClaudeCodeUpdate().catch((e) => console.error("Claude Code 更新检查异常:", e));
    }

    // v1.9.13+: 定期扫 registry 找 dead agent（active 但 tmux window 丢了的）
    // 有就挨个 restart。没 dead 是 no-op，不 churn 健康 agent。
    // 升级波租约内停手——波会依次重建每个窗口,巡检在空档扫到「dead」就会并发
    // 再 restart 一次,双窗口抢 session 双双失败(2026-07-27 ld-binance 实锤)。
    if (Date.now() - lastDeadAgentCheck >= DEAD_AGENT_CHECK_INTERVAL_MS && Date.now() >= restartWaveUntil) {
      lastDeadAgentCheck = Date.now();
      restoreDeadAgents("periodic").catch(() => {});
    }

    // 检查 Claude Code 是否还活着。
    // v1.9.19+ 优先用进程层检查：master:0 pane 的 shell 有没有子进程。
    // Claude Code 是 shell 的子进程 —— 有子就活着，没子就挂了。完全不看
    // pane 文本，和用户 prompt 主题 / Claude 改 tmux title 都无关。
    // 查不到（null，pane 本身就没了）fallback 回文本检测。
    const claudeAlive = await windowHasChildProcess(MASTER_WINDOW);
    let deadAtShell: boolean;
    if (claudeAlive === null) {
      // 进程检查失败（window 丢了？），用文本兜底
      const nonEmpty = pane.split("\n").filter((l) => l.trim());
      const tail = nonEmpty.slice(-5).join("\n");
      const hasClaudeTui = CC_MODE_BANNER_RE.test(tail) || /esc to interrupt/i.test(tail);
      const lastLine = nonEmpty.pop() || "";
      deadAtShell =
        !hasClaudeTui &&
        (/[%$#>❯»λ]\s*$/.test(lastLine) || /➜\s+\S/.test(lastLine));
    } else {
      deadAtShell = !claudeAlive;
    }

    if (deadAtShell) {
      console.log("💀 大总管退回了 shell（无子进程），正在重新启动 Claude Code...");
      await bringUpClaudeInMasterWindow();
    }
  }
}

main().catch((err) => {
  console.error("Launcher 崩溃:", err);
  process.exit(1);
});
