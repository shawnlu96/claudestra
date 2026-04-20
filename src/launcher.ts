/**
 * Master Session Launcher
 *
 * pm2 管理的守护进程，确保大总管的 tmux session 始终存活。
 * 如果 session 死了自动重启。
 */

import {
  tmuxRaw,
  masterSessionExists,
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

async function startMaster() {
  console.log("🚀 启动大总管 session...");

  // 确保 socket 目录存在
  await ensureSocketDir();

  // 创建 tmux session
  await tmuxRaw(["new-session", "-d", "-s", SESSION_NAME, "-c", MASTER_DIR]);
  await Bun.sleep(500);

  // 启动 Claude Code（用统一的命令构造器）
  const cmd = buildClaudeCommand({
    channelId: CONTROL_CHANNEL_ID,
    bridgeUrl: BRIDGE_URL,
  });
  await tmuxSendLine(MASTER_WINDOW, cmd);

  // 等待并自动确认各种提示（dev channel、trust、bypass、etc）
  for (let i = 0; i < 120; i++) {
    await Bun.sleep(500);
    const pane = await captureLast(10);

    if (await isIdle()) {
      console.log("✅ 大总管已就绪");
      return true;
    }

    if (masterShouldAutoConfirm(pane)) {
      await tmuxRaw(["send-keys", "-t", MASTER_WINDOW, "Enter"]);
      await Bun.sleep(500);
      continue;
    }
  }

  console.log("⚠️ 大总管启动超时，但 session 可能仍在初始化");
  return await sessionExists();
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
  if (await sessionExists()) {
    console.log("✅ 大总管 session 已存在，进入监控模式");
  } else {
    await startMaster();
  }

  // 持续监控
  while (true) {
    await Bun.sleep(CHECK_INTERVAL_MS);

    if (!(await sessionExists())) {
      console.log("💀 大总管 tmux session 不存在，正在重启...");
      await startMaster();
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

    // 检查 Claude Code 是否还活着（不是退回了 shell）
    const atShell = /[%$]\s*$/.test(pane.split("\n").filter((l) => l.trim()).pop() || "");
    if (atShell) {
      console.log("💀 大总管退回了 shell，正在重新启动 Claude Code...");
      const cmd = buildClaudeCommand({
        channelId: CONTROL_CHANNEL_ID,
        bridgeUrl: BRIDGE_URL,
      });
      await tmuxSendLine(MASTER_WINDOW, cmd);
      // 等待确认
      for (let i = 0; i < 120; i++) {
        await Bun.sleep(500);
        const p = await captureLast(10);
        if (await isIdle()) {
          console.log("✅ 大总管已重新就绪");
          break;
        }
        if (masterShouldAutoConfirm(p)) {
          await tmuxRaw(["send-keys", "-t", MASTER_WINDOW, "Enter"]);
          await Bun.sleep(500);
        }
      }
    }
  }
}

main().catch((err) => {
  console.error("Launcher 崩溃:", err);
  process.exit(1);
});
