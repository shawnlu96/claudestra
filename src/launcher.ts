/**
 * Master Session Launcher
 *
 * pm2 管理的守护进程，确保大总管的 tmux session 始终存活。
 * 如果 session 死了自动重启。
 */

const SOCK = "/tmp/claude-orchestrator/master.sock";
const SESSION_NAME = "master";
const MASTER_DIR = `${process.env.HOME}/repos/claude-orchestrator/master`;
const CONTROL_CHANNEL_ID = process.env.CONTROL_CHANNEL_ID || "";
const BRIDGE_URL = process.env.BRIDGE_URL || "ws://localhost:3847";
const CHECK_INTERVAL_MS = 15_000; // 每 15 秒检查一次

if (!CONTROL_CHANNEL_ID) {
  console.error("❌ 请设置 CONTROL_CHANNEL_ID（Discord #control 频道 ID）");
  process.exit(1);
}

async function tmux(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", "-S", SOCK, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

async function sessionExists(): Promise<boolean> {
  const out = await tmux("list-sessions", "-F", "#{session_name}");
  return out.split("\n").includes(SESSION_NAME);
}

async function isIdle(): Promise<boolean> {
  const tail = await tmux("capture-pane", "-t", SESSION_NAME, "-p");
  return /❯/.test(tail.split("\n").slice(-5).join("\n"));
}

async function captureLast(lines = 10): Promise<string> {
  return tmux("capture-pane", "-t", SESSION_NAME, "-p", "-J", "-S", `-${lines}`);
}

async function startMaster() {
  console.log("🚀 启动大总管 session...");

  // 确保 socket 目录存在
  await Bun.spawn(["mkdir", "-p", "/tmp/claude-orchestrator"]).exited;

  // 创建 tmux session
  await tmux("new-session", "-d", "-s", SESSION_NAME, "-c", MASTER_DIR);
  await Bun.sleep(500);

  // 启动 Claude Code
  const cmd = `DISCORD_CHANNEL_ID=${CONTROL_CHANNEL_ID} BRIDGE_URL=${BRIDGE_URL} claude --dangerously-load-development-channels server:discord-bridge --dangerously-skip-permissions`;
  await tmux("send-keys", "-t", SESSION_NAME, "-l", "--", cmd);
  await Bun.sleep(100);
  await tmux("send-keys", "-t", SESSION_NAME, "Enter");

  // 等待并自动确认 development channel 提示
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(1000);
    const pane = await captureLast(10);
    if (pane.includes("I am using this for local development")) {
      await tmux("send-keys", "-t", SESSION_NAME, "Enter");
      continue;
    }
    if (await isIdle()) {
      console.log("✅ 大总管已就绪");
      return true;
    }
  }

  console.log("⚠️ 大总管启动超时，但 session 可能仍在初始化");
  return await sessionExists();
}

// ============================================================
// 主循环
// ============================================================

async function main() {
  console.log(`📡 Launcher 启动`);
  console.log(`   tmux socket: ${SOCK}`);
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
      console.log("💀 大总管 session 已死，正在重启...");
      await startMaster();
    }
  }
}

main().catch((err) => {
  console.error("Launcher 崩溃:", err);
  process.exit(1);
});
