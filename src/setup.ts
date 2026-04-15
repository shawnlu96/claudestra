#!/usr/bin/env bun
/**
 * Claudestra 交互式安装脚本
 *
 * 使用方式：
 *   bun run src/setup.ts
 *
 * 会做这些事：
 *   1. 交互式收集 Discord 配置（bot token / guild id / user id / control channel / 你的名字）
 *   2. 写入 .env
 *   3. 渲染 master/CLAUDE.md.template → master/CLAUDE.md
 *   4. 提示接下来要手动做的步骤（MCP 注册、pm2 启动等）
 */

import { readFile, writeFile, access } from "fs/promises";
import { constants } from "fs";
import { resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENV_PATH = `${REPO_ROOT}/.env`;
const ENV_EXAMPLE_PATH = `${REPO_ROOT}/.env.example`;
const TEMPLATE_PATH = `${REPO_ROOT}/master/CLAUDE.md.template`;
const RENDERED_PATH = `${REPO_ROOT}/master/CLAUDE.md`;

// ============================================================
// 交互辅助
// ============================================================

const stdin = process.stdin;
const stdout = process.stdout;

function print(msg: string) {
  stdout.write(msg);
}

function println(msg = "") {
  stdout.write(msg + "\n");
}

async function prompt(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolveFn) => {
    const hint = defaultValue ? ` [${defaultValue}]` : "";
    print(`${question}${hint}: `);
    stdin.resume();
    stdin.setEncoding("utf-8");
    stdin.once("data", (data) => {
      stdin.pause();
      const answer = data.toString().trim();
      resolveFn(answer || defaultValue || "");
    });
  });
}

async function promptRequired(question: string): Promise<string> {
  while (true) {
    const answer = await prompt(question);
    if (answer) return answer;
    println("  ⚠️  此项必填，请重新输入");
  }
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await prompt(`${question} ${suffix}`)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// 配置收集
// ============================================================

interface Config {
  DISCORD_BOT_TOKEN: string;
  DISCORD_GUILD_ID: string;
  ALLOWED_USER_IDS: string;
  CONTROL_CHANNEL_ID: string;
  BRIDGE_PORT: string;
  USER_NAME: string;
  MCP_NAME: string;
}

async function collectConfig(existing: Partial<Config>): Promise<Config> {
  println("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  println("  Claudestra 安装向导");
  println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  println("在填写之前，确认你已经：");
  println("  ✓ 在 https://discord.com/developers/applications 创建了应用和 Bot");
  println("  ✓ 在 Bot 页开启了 MESSAGE CONTENT / SERVER MEMBERS / PRESENCE 三个 Privileged Intent");
  println("  ✓ 用 OAuth2 URL 生成器把 bot 邀请到你的 Discord server");
  println("  ✓ 在你的 server 里创建了一个专属 #agent-大总管 文字频道");
  println("  ✓ 在 Discord 用户设置开启了『开发者模式』（用于右键复制 ID）\n");

  if (!(await confirm("以上都做完了？"))) {
    println("\n请先看 SETUP.md 完成准备步骤，然后重跑 `bun run setup`。");
    process.exit(0);
  }

  println("");
  const DISCORD_BOT_TOKEN = await promptRequired("Discord Bot Token (Bot 页面 → Reset Token 后复制)");
  const DISCORD_GUILD_ID = await promptRequired("Discord Guild/Server ID (右键服务器图标 → 复制服务器 ID)");
  const ALLOWED_USER_IDS = await promptRequired("你的 Discord User ID (右键自己 → 复制用户 ID)");
  const CONTROL_CHANNEL_ID = await promptRequired("#agent-大总管 频道 ID (右键频道 → 复制频道 ID)");
  const BRIDGE_PORT = await prompt("Bridge WebSocket 端口", existing.BRIDGE_PORT || "3847");
  const USER_NAME = await promptRequired("你的称呼（大总管会这样叫你，如 Jack/小明）");
  const MCP_NAME = await prompt("MCP server 名称（默认即可）", existing.MCP_NAME || "claudestra");

  return {
    DISCORD_BOT_TOKEN,
    DISCORD_GUILD_ID,
    ALLOWED_USER_IDS,
    CONTROL_CHANNEL_ID,
    BRIDGE_PORT,
    USER_NAME,
    MCP_NAME,
  };
}

function buildEnvContent(cfg: Config): string {
  return [
    `DISCORD_BOT_TOKEN=${cfg.DISCORD_BOT_TOKEN}`,
    `DISCORD_GUILD_ID=${cfg.DISCORD_GUILD_ID}`,
    `ALLOWED_USER_IDS=${cfg.ALLOWED_USER_IDS}`,
    `CONTROL_CHANNEL_ID=${cfg.CONTROL_CHANNEL_ID}`,
    `BRIDGE_PORT=${cfg.BRIDGE_PORT}`,
    `USER_NAME=${cfg.USER_NAME}`,
    `MCP_NAME=${cfg.MCP_NAME}`,
    "",
  ].join("\n");
}

function parseEnv(content: string): Partial<Config> {
  const out: Partial<Config> = {};
  for (const line of content.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) (out as any)[m[1]] = m[2];
  }
  return out;
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  // 1. 读取现有 .env 或 .env.example 作为默认值
  let existing: Partial<Config> = {};
  if (await fileExists(ENV_PATH)) {
    println("📄 检测到已有 .env，将作为默认值");
    existing = parseEnv(await readFile(ENV_PATH, "utf-8"));
  } else if (await fileExists(ENV_EXAMPLE_PATH)) {
    existing = parseEnv(await readFile(ENV_EXAMPLE_PATH, "utf-8"));
  }

  // 2. 收集配置
  const cfg = await collectConfig(existing);

  // 3. 写 .env
  if (await fileExists(ENV_PATH)) {
    if (!(await confirm("\n.env 已存在，要覆盖吗？", false))) {
      println("❌ 已取消，未写入 .env");
      process.exit(1);
    }
  }
  await writeFile(ENV_PATH, buildEnvContent(cfg));
  println(`\n✅ 已写入 ${ENV_PATH}`);

  // 4. 渲染 master/CLAUDE.md
  if (await fileExists(TEMPLATE_PATH)) {
    let tpl = await readFile(TEMPLATE_PATH, "utf-8");
    tpl = tpl.replaceAll("{{USER_NAME}}", cfg.USER_NAME);
    await writeFile(RENDERED_PATH, tpl);
    println(`✅ 已渲染 ${RENDERED_PATH}（大总管指令，用户名 = ${cfg.USER_NAME}）`);
  } else {
    println(`⚠️  未找到 ${TEMPLATE_PATH}，跳过大总管 CLAUDE.md 生成`);
  }

  // 5. 后续步骤提示
  println("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  println("  接下来要手动做的事");
  println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  println("1️⃣  安装依赖（如果还没装）:");
  println("    bun install");
  println("    npx playwright install chromium");
  println("");
  println("2️⃣  注册 Claude Code MCP server（让 agent 能收发 Discord）:");
  println(`    claude mcp remove ${cfg.MCP_NAME} -s user 2>/dev/null`);
  println(`    claude mcp add ${cfg.MCP_NAME} -s user -- bun run ${REPO_ROOT}/src/channel-server.ts`);
  println("");
  println("3️⃣  启动 pm2 服务:");
  println(`    pm2 start ${REPO_ROOT}/ecosystem.config.cjs`);
  println("    pm2 save");
  println("    pm2 startup   # 首次才需要");
  println("");
  println("4️⃣  到 Discord #agent-大总管 频道发一句话，看大总管有没有回复。");
  println("");
  println("如果出问题，pm2 logs discord-bridge 看日志。\n");
}

main().catch((err) => {
  console.error("\n❌ setup 失败:", err);
  process.exit(1);
});
