/**
 * Master Session Launcher
 *
 * pm2 管理的守护进程，确保大总管的 tmux session 始终存活。
 * 如果 session 死了自动重启。
 */

import { enableTimestampLogs } from "./lib/log-timestamp.js";
enableTimestampLogs(); // 给所有 console log 加 ISO timestamp 前缀（daemon 专用）

import {
  tmuxRaw,
  masterSessionExists,
  masterWindowExists,
  ensureSocketDir,
  isIdle as tmuxIsIdle,
  tmuxCapture,
  tmuxSendLine,
  hasClaudePromptToConfirm,
  detectSessionIdlePrompt,
  listAgentWindows,
  windowTarget,
  MASTER_SESSION as SESSION_NAME,
} from "./lib/tmux-helper.js";

/**
 * Master 专用确认检测：除了 hasClaudePromptToConfirm 覆盖的弹窗，
 * session-idle 也自动选"从摘要恢复"（按 Enter 选默认的 1）。
 * agent 的 session-idle 由 permission-watcher 给用户按钮，master 则总是自动处理。
 */
function masterShouldAutoConfirm(pane: string): boolean {
  return hasClaudePromptToConfirm(pane) || detectSessionIdlePrompt(pane) !== null;
}
import { buildClaudeCommand } from "./lib/claude-launch.js";
import { bridgeRequest } from "./lib/bridge-client.js";
import { readConfig } from "./lib/config-store.js";

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
      await tmuxRaw(["send-keys", "-t", MASTER_WINDOW, "Enter"]);
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

async function checkForUpdates() {
  if (!CONTROL_CHANNEL_ID) return;

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
          `🆕 **Claudestra ${release.tag} 发布了！** ${ALLOWED_USER_IDS.map(id => `<@${id}>`).join(" ")}`,
          ``,
          `当前: v${local} → 最新: ${release.tag}`,
          release.body ? `\n${release.body.slice(0, 500)}` : "",
          ``,
          `自动更新已关闭。更新命令: \`bun src/manager.ts update\``,
          `（开启自动更新: \`bun src/manager.ts auto-update claudestra on\`）`,
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
      text: `🆕 **Claudestra ${release.tag} 自动更新中** ${mention}\n\nv${local} → ${release.tag}，所有 agent 当前空闲，开始 git pull + pm2 restart...`,
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
let lastDeadAgentCheck = 0;

async function runCmd(cmd: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return { ok: proc.exitCode === 0, out: out.trim() };
}

async function getClaudeVersion(): Promise<string | null> {
  const { ok, out } = await runCmd(["claude", "--version"]);
  if (!ok) return null;
  const m = out.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

async function getClaudeLatestVersion(): Promise<string | null> {
  const { ok, out } = await runCmd(["npm", "view", "@anthropic-ai/claude-code", "version"]);
  if (!ok) return null;
  const m = out.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
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
    console.log(`🔁 [${source}] 发现 ${reallyDead.length} 个 dead agent：${reallyDead.map((a: any) => a.name).join(", ")}`);
    if (source === "boot") {
      try {
        await bridgeRequest({
          type: "reply",
          chatId: CONTROL_CHANNEL_ID,
          text: `🔁 检测到 ${reallyDead.length} 个 agent 需要开机后恢复：${reallyDead.map((a: any) => `\`${a.name}\``).join(" / ")}\n正在 resume 它们的历史会话，几十秒内会陆续回到原频道。`,
        });
      } catch { /* non-critical */ }
    }
    // 对每个 dead agent 单独调 restart <name>，不 churn 健康的 agent
    for (const agent of reallyDead) {
      console.log(`🔁 [${source}] 重启 ${agent.name}...`);
      await runCmd(["bun", "run", `${REPO_ROOT}/src/manager.ts`, "restart", agent.name]);
    }
    console.log(`🔁 [${source}] restart 调用完成`);
  } catch (e) {
    console.error(`🔁 [${source}] 自检失败:`, e);
  }
}

async function restartAgentsAndMaster() {
  // 所有 agent 由 manager restart 处理（使用 registry 中的 sessionId + channelId）
  const { ok, out } = await runCmd(["bun", "run", `${REPO_ROOT}/src/manager.ts`, "restart"]);
  console.log(`🆙 bun manager restart 结果: ok=${ok}`);
  if (!ok) console.log(out);

  // master 通过发送 /exit 让其退出，主循环会自动重启
  await tmuxRaw(["send-keys", "-t", MASTER_WINDOW, "/exit", "Enter"]).catch(() => {});
}

async function checkClaudeCodeUpdate() {
  const cfg = await readConfig();
  if (!cfg.autoUpdate.claudeCode) return; // 开关关闭 → 跳过

  const current = await getClaudeVersion();
  if (!current) return;
  const latest = await getClaudeLatestVersion();
  if (!latest) return;
  if (current === latest) return;

  console.log(`🆙 Claude Code 有新版本: ${current} → ${latest}`);

  // 等所有 agent 空闲再更新（避免打断正在进行的任务）
  if (!(await allAgentsIdle())) {
    console.log(`🆙 有 agent 在忙，跳过本次，下次再试`);
    return;
  }

  console.log(`🆙 所有 agent 空闲，开始更新 Claude Code`);
  try {
    const mention = ALLOWED_USER_IDS.map((id) => `<@${id}>`).join(" ");
    await bridgeRequest({
      type: "reply",
      chatId: CONTROL_CHANNEL_ID,
      text: `🆙 **Claude Code 新版本** ${current} → ${latest} ${mention}\n\n所有 agent 当前空闲，开始 npm install + 重启...`,
    });
  } catch { /* non-critical */ }

  const install = await runCmd(["npm", "install", "-g", "@anthropic-ai/claude-code"]);
  if (!install.ok) {
    console.log(`🆙 npm install 失败: ${install.out}`);
    try {
      await bridgeRequest({
        type: "reply",
        chatId: CONTROL_CHANNEL_ID,
        text: `⚠️ Claude Code 更新失败（npm install 返回错误），详见 launcher 日志`,
      });
    } catch { /* non-critical */ }
    return;
  }

  // 确认版本
  const afterVersion = await getClaudeVersion();
  console.log(`🆙 Claude Code 已更新到 ${afterVersion}`);

  await restartAgentsAndMaster();

  try {
    await bridgeRequest({
      type: "reply",
      chatId: CONTROL_CHANNEL_ID,
      text: `✅ **Claude Code 更新完成** v${afterVersion}，所有 agent 已重启 ${ALLOWED_USER_IDS.map((id) => `<@${id}>`).join(" ")}`,
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
      await tmuxRaw(["send-keys", "-t", MASTER_WINDOW, "Enter"]);
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
    if (Date.now() - lastDeadAgentCheck >= DEAD_AGENT_CHECK_INTERVAL_MS) {
      lastDeadAgentCheck = Date.now();
      restoreDeadAgents("periodic").catch(() => {});
    }

    // 检查 Claude Code 是否还活着（不是退回了 shell）
    // 与 manager.ts isAtShell 保持一致：先排除 Claude Code TUI 标志，再识别 shell prompt。
    // 支持两类 prompt：
    //   (1) 结尾是 prompt 字符 —— $ % # > ❯ » λ（bash/zsh/starship/pure/lambda）
    //   (2) oh-my-zsh robbyrussell 主题 —— 形如 "➜  dir git:(branch) ✗"，结尾不一定是 prompt 字符，
    //       但一定能看到 "➜<空格><路径>" 这个典型片段（v1.9.15 修：peer 就是这个主题挂掉的）
    const nonEmpty = pane.split("\n").filter((l) => l.trim());
    const tail = nonEmpty.slice(-5).join("\n");
    const hasClaudeTui = /bypass permissions|esc to interrupt/i.test(tail);
    const lastLine = nonEmpty.pop() || "";
    const atShell =
      !hasClaudeTui &&
      (/[%$#>❯»λ]\s*$/.test(lastLine) || /➜\s+\S/.test(lastLine));
    if (atShell) {
      console.log("💀 大总管退回了 shell，正在重新启动 Claude Code...");
      // 复用 bringUpClaudeInMasterWindow —— 自带 effort 设置 + 弹窗自动确认，
      // update 流程（cmdUpdate 发 /exit 把 Claude 退回 shell）也会走到这条路径。
      await bringUpClaudeInMasterWindow();
    }
  }
}

main().catch((err) => {
  console.error("Launcher 崩溃:", err);
  process.exit(1);
});
