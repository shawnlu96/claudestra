#!/usr/bin/env bun
/**
 * Claudestra 傻瓜式安装向导
 *
 * 用法：bun run setup
 *
 * 这个脚本把所有 Discord 配置步骤都内置了，你不需要读文档。
 * 跟着它走，它会告诉你每一步点哪里、复制什么、粘贴到哪。
 */

import { readFile, writeFile, access } from "fs/promises";
import { constants } from "fs";
import { resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENV_PATH = `${REPO_ROOT}/.env`;
const ENV_EXAMPLE_PATH = `${REPO_ROOT}/.env.example`;
const TEMPLATE_PATH = `${REPO_ROOT}/master/CLAUDE.md.template`;
const RENDERED_PATH = `${REPO_ROOT}/master/CLAUDE.md`;

const TOTAL_STEPS = 8;

// ============================================================
// 终端着色
// ============================================================

const tty = process.stdout.isTTY;
const c = {
  reset: tty ? "\x1b[0m" : "",
  bold: tty ? "\x1b[1m" : "",
  dim: tty ? "\x1b[2m" : "",
  red: tty ? "\x1b[31m" : "",
  green: tty ? "\x1b[32m" : "",
  yellow: tty ? "\x1b[33m" : "",
  blue: tty ? "\x1b[34m" : "",
  magenta: tty ? "\x1b[35m" : "",
  cyan: tty ? "\x1b[36m" : "",
};

function print(s = "") { process.stdout.write(s + "\n"); }
function write(s: string) { process.stdout.write(s); }
function br() { print(""); }

function header(step: number, title: string) {
  const bar = "━".repeat(50);
  print("");
  print(`${c.cyan}${bar}${c.reset}`);
  print(`${c.bold}${c.cyan}  [${step}/${TOTAL_STEPS}] ${title}${c.reset}`);
  print(`${c.cyan}${bar}${c.reset}`);
  print("");
}

function step(n: string, text: string) {
  print(`${c.bold}${c.magenta}${n}${c.reset} ${text}`);
}

function hint(text: string) {
  print(`  ${c.dim}${text}${c.reset}`);
}

function url(u: string) {
  return `${c.blue}${c.bold}${u}${c.reset}`;
}

function kbd(key: string) {
  return `${c.yellow}${c.bold}${key}${c.reset}`;
}

function ok(text: string) {
  print(`${c.green}✓${c.reset}  ${text}`);
}

function warn(text: string) {
  print(`${c.yellow}⚠${c.reset}  ${text}`);
}

function fail(text: string) {
  print(`${c.red}✗${c.reset}  ${text}`);
}

// ============================================================
// 输入
// ============================================================

const stdin = process.stdin;

function readLine(): Promise<string> {
  return new Promise((resolveFn) => {
    stdin.resume();
    stdin.setEncoding("utf-8");
    const onData = (data: Buffer) => {
      stdin.pause();
      stdin.off("data", onData);
      resolveFn(data.toString().replace(/\n$/, ""));
    };
    stdin.on("data", onData);
  });
}

async function waitEnter(msg = "完成后按 ENTER 继续") {
  write(`${c.dim}  ${msg}…${c.reset}`);
  await readLine();
}

async function prompt(label: string, defaultValue?: string): Promise<string> {
  const hint = defaultValue ? ` ${c.dim}[${defaultValue}]${c.reset}` : "";
  write(`${c.bold}${label}${c.reset}${hint}: `);
  const answer = (await readLine()).trim();
  return answer || defaultValue || "";
}

async function promptRequired(label: string, validator?: (v: string) => string | null): Promise<string> {
  while (true) {
    const answer = await prompt(label);
    if (!answer) {
      fail("这项必填，再试一次");
      continue;
    }
    if (validator) {
      const err = validator(answer);
      if (err) {
        fail(err);
        continue;
      }
    }
    return answer;
  }
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? `${c.dim}[Y/n]${c.reset}` : `${c.dim}[y/N]${c.reset}`;
  write(`${c.bold}${question}${c.reset} ${hint} `);
  const answer = (await readLine()).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

// ============================================================
// 校验
// ============================================================

function validateSnowflake(v: string): string | null {
  if (!/^[0-9]{17,20}$/.test(v)) {
    return "Discord ID 应该是 17-20 位数字。你是不是复制错了？（记得开启开发者模式右键 → 复制 ID）";
  }
  return null;
}

function validateToken(v: string): string | null {
  if (v.length < 30) {
    return "token 看起来太短。Discord bot token 至少 50+ 字符";
  }
  if (v.includes(" ")) {
    return "token 不应该包含空格，是不是多复制了东西？";
  }
  return null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch { return false; }
}

async function which(cmd: string): Promise<boolean> {
  const proc = Bun.spawn(["which", cmd], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  return proc.exitCode === 0;
}

async function run(cmd: string[], opts: { cwd?: string } = {}): Promise<{ ok: boolean; out: string; err: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { ok: code === 0, out, err };
}

// ============================================================
// 步骤 1：依赖检查
// ============================================================

async function stepCheckDeps(): Promise<void> {
  header(1, "检查系统依赖");

  print("Claudestra 需要以下 5 个工具才能跑起来：");
  br();

  const deps: Array<{ cmd: string; install: string; required: boolean }> = [
    { cmd: "git", install: "brew install git（或系统自带）", required: true },
    { cmd: "tmux", install: "brew install tmux", required: true },
    { cmd: "bun", install: "curl -fsSL https://bun.sh/install | bash", required: true },
    { cmd: "pm2", install: "npm install -g pm2", required: true },
    { cmd: "claude", install: "npm install -g @anthropic-ai/claude-code", required: true },
  ];

  let missing = 0;
  for (const d of deps) {
    const has = await which(d.cmd);
    if (has) {
      ok(`${c.bold}${d.cmd}${c.reset}`);
    } else {
      fail(`${c.bold}${d.cmd}${c.reset} — 未安装`);
      hint(`安装命令: ${c.cyan}${d.install}${c.reset}`);
      missing++;
    }
  }

  if (missing > 0) {
    br();
    warn(`缺少 ${missing} 个依赖。`);
    hint("装好上面缺的工具后重跑: bun run setup");
    process.exit(1);
  }

  br();
  ok("系统依赖就绪 ✨");
}

// ============================================================
// 步骤 2：创建 Discord 应用
// ============================================================

async function stepCreateApp(): Promise<void> {
  header(2, "创建 Discord 应用");

  print("要让 bot 进你的服务器，先在 Discord 开发者门户创建一个应用。");
  br();

  step("①", `打开浏览器: ${url("https://discord.com/developers/applications")}`);
  step("②", `点右上角 ${c.bold}${c.green}New Application${c.reset}（绿色按钮）`);
  step("③", `起个名字 —— ${c.yellow}claudestra${c.reset} 或你喜欢的任何名字`);
  step("④", `勾选同意条款 → 点 ${c.bold}Create${c.reset}`);

  br();
  await waitEnter();
}

// ============================================================
// 步骤 3：获取 Bot Token
// ============================================================

async function stepGetToken(): Promise<string> {
  header(3, "获取 Bot Token");

  print("Bot token 是 bot 的身份凭证。别告诉任何人，更别传到 GitHub。");
  br();

  step("①", `在左边栏点 ${c.bold}Bot${c.reset}（机器人图标）`);
  step("②", `如果提示 Add Bot，点 ${c.bold}Yes, do it!${c.reset}`);
  step("③", `点 ${c.bold}${c.red}Reset Token${c.reset}（可能需要 2FA 确认）`);
  step("④", `${c.bold}${c.green}立即复制${c.reset}弹出的 token —— 它只显示一次！`);

  br();
  warn("token 格式类似 " + c.dim + "MTIzNDU2Nzg5MDEyMzQ1Njc4.XXXXXXX.YYYYY..." + c.reset);
  br();

  const token = await promptRequired(`${kbd("粘贴 token")}`, validateToken);
  ok("token 收到");
  return token;
}

// ============================================================
// 步骤 4：开启 Privileged Intents
// ============================================================

async function stepIntents(): Promise<void> {
  header(4, "开启 Privileged Intents");

  print("Discord 对敏感 API 有三个 intent 开关，bot 必须全部打开才能正常工作。");
  br();

  step("①", `你应该还在 Bot 页面。往下滚到 ${c.bold}Privileged Gateway Intents${c.reset} 区块`);
  step("②", `把这三个开关全部打开：`);
  print(`     ${c.green}▢${c.reset} → ${c.green}▣${c.reset} ${c.bold}PRESENCE INTENT${c.reset}`);
  print(`     ${c.green}▢${c.reset} → ${c.green}▣${c.reset} ${c.bold}SERVER MEMBERS INTENT${c.reset}`);
  print(`     ${c.green}▢${c.reset} → ${c.green}▣${c.reset} ${c.bold}MESSAGE CONTENT INTENT${c.reset}`);
  step("③", `点页面底部的 ${c.bold}${c.green}Save Changes${c.reset}`);

  br();
  warn("少一个 intent，bot 都会静默忽略消息 —— 不会报错，只是没反应");
  br();
  await waitEnter();
}

// ============================================================
// 步骤 5：邀请 Bot 到服务器
// ============================================================

async function stepInviteBot(): Promise<void> {
  header(5, "邀请 Bot 到你的服务器");

  print("生成一个邀请链接，把 bot 拉进你要管理的 Discord 服务器。");
  br();

  step("①", `左边栏 → ${c.bold}OAuth2${c.reset} → ${c.bold}URL Generator${c.reset}`);

  br();
  step("②", `${c.bold}SCOPES${c.reset} 勾选这两个：`);
  print(`     ${c.green}▣${c.reset} bot`);
  print(`     ${c.green}▣${c.reset} applications.commands`);

  br();
  step("③", `${c.bold}BOT PERMISSIONS${c.reset} 勾选这 7 个：`);
  print(`     ${c.green}▣${c.reset} View Channels`);
  print(`     ${c.green}▣${c.reset} Send Messages`);
  print(`     ${c.green}▣${c.reset} Read Message History`);
  print(`     ${c.green}▣${c.reset} ${c.yellow}Manage Channels${c.reset}  ${c.dim}(bridge 要自动建 agent 频道)${c.reset}`);
  print(`     ${c.green}▣${c.reset} Attach Files`);
  print(`     ${c.green}▣${c.reset} Add Reactions`);
  print(`     ${c.green}▣${c.reset} Embed Links`);

  br();
  step("④", `复制页面最底部的 ${c.bold}GENERATED URL${c.reset}`);
  step("⑤", `在浏览器打开那个 URL → 选择你的服务器 → ${c.bold}${c.green}授权${c.reset}`);

  br();
  hint("授权成功后，bot 会出现在服务器成员列表里（离线状态，正常）");
  await waitEnter();
}

// ============================================================
// 步骤 6：开启开发者模式 + 收集 ID
// ============================================================

async function stepCollectIds(): Promise<{
  guildId: string;
  userId: string;
  controlChannelId: string;
}> {
  header(6, "开启开发者模式 + 收集 ID");

  print("下面要从 Discord 里复制 3 个 ID。先打开开发者模式，不然右键看不到\"复制 ID\"。");
  br();

  step("①", `Discord 左下角齿轮 → ${c.bold}用户设置${c.reset}`);
  step("②", `左边栏 → ${c.bold}高级${c.reset}（App Settings 下面）`);
  step("③", `打开 ${c.bold}${c.green}开发者模式${c.reset}`);
  step("④", `关闭设置面板`);

  br();
  await waitEnter("开启开发者模式后按 ENTER");

  // ── Guild ID ──
  br();
  print(`${c.bold}${c.yellow}▼ 服务器 ID (Guild ID)${c.reset}`);
  step("①", `${c.bold}右键${c.reset}左边栏顶部你的服务器图标`);
  step("②", `菜单最底部点 ${c.bold}复制服务器 ID${c.reset}`);
  br();
  const guildId = await promptRequired(`${kbd("粘贴服务器 ID")}`, validateSnowflake);
  ok("服务器 ID 收到");

  // ── User ID ──
  br();
  print(`${c.bold}${c.yellow}▼ 你自己的用户 ID${c.reset}`);
  hint("bridge 只响应这个 ID，防止别人乱用 bot");
  step("①", `随便哪个频道里，${c.bold}右键${c.reset}你自己的名字`);
  step("②", `菜单最底部点 ${c.bold}复制用户 ID${c.reset}`);
  br();
  const userId = await promptRequired(`${kbd("粘贴你的用户 ID")}`, validateSnowflake);
  ok("用户 ID 收到");

  // ── Control Channel ──
  br();
  print(`${c.bold}${c.yellow}▼ 控制频道${c.reset}`);
  print("你还需要一个文字频道作为 \"大总管\" 的控制台。");
  step("①", `在你的服务器里建一个文字频道 —— ${c.yellow}#claudestra-control${c.reset} 或者你喜欢的任何名字`);
  step("②", `${c.bold}右键${c.reset}刚建的频道 → ${c.bold}复制频道 ID${c.reset}`);
  br();
  const controlChannelId = await promptRequired(`${kbd("粘贴控制频道 ID")}`, validateSnowflake);
  ok("控制频道 ID 收到");

  return { guildId, userId, controlChannelId };
}

// ============================================================
// 步骤 7：个人偏好
// ============================================================

async function stepPreferences(existing: Partial<Config>): Promise<{
  userName: string;
  mcpName: string;
  bridgePort: string;
}> {
  header(7, "个人偏好");

  print("最后几个小问题，都有默认值，直接按 ENTER 就行。");
  br();

  const userName = await promptRequired(`${kbd("你的称呼")} ${c.dim}(大总管在 Discord 里怎么叫你)${c.reset}`);
  const mcpName = await prompt(`${kbd("MCP 服务名")}`, existing.MCP_NAME || "claudestra");
  const bridgePort = await prompt(`${kbd("Bridge 端口")}`, existing.BRIDGE_PORT || "3847");

  return { userName, mcpName, bridgePort };
}

// ============================================================
// 步骤 8：写入配置 + 自动化收尾
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

function buildEnvContent(cfg: Config): string {
  return [
    "# Claudestra 运行时配置 (由 bun run setup 生成)",
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

async function stepFinalize(cfg: Config): Promise<void> {
  header(8, "写入配置 + 自动化收尾");

  // 写 .env
  if (await fileExists(ENV_PATH)) {
    warn(".env 已存在");
    if (!(await confirm("要覆盖吗？", false))) {
      fail("已取消。你现有的 .env 没被动");
      process.exit(1);
    }
  }
  await writeFile(ENV_PATH, buildEnvContent(cfg));
  ok(`写入 ${c.bold}.env${c.reset}`);

  // 渲染 master/CLAUDE.md
  if (await fileExists(TEMPLATE_PATH)) {
    let tpl = await readFile(TEMPLATE_PATH, "utf-8");
    tpl = tpl.replaceAll("{{USER_NAME}}", cfg.USER_NAME);
    await writeFile(RENDERED_PATH, tpl);
    ok(`渲染 ${c.bold}master/CLAUDE.md${c.reset}（你的名字: ${c.yellow}${cfg.USER_NAME}${c.reset}）`);
  }

  br();

  // 自动跑依赖安装 + MCP 注册 + pm2 start
  print("下面这些命令我可以直接帮你跑掉，一键启动:");
  print(`  ${c.dim}•${c.reset} ${c.cyan}bun install${c.reset}`);
  print(`  ${c.dim}•${c.reset} ${c.cyan}npx playwright install chromium${c.reset}  ${c.dim}(终端截图用)${c.reset}`);
  print(`  ${c.dim}•${c.reset} ${c.cyan}claude mcp add ${cfg.MCP_NAME} ...${c.reset}  ${c.dim}(注册 MCP server)${c.reset}`);
  print(`  ${c.dim}•${c.reset} ${c.cyan}pm2 start ecosystem.config.cjs${c.reset}  ${c.dim}(启动服务)${c.reset}`);
  br();

  if (!(await confirm("要我一键帮你跑完吗？", true))) {
    br();
    ok("配置已保存。剩下的命令自己跑：");
    print(`  ${c.cyan}cd ${REPO_ROOT}${c.reset}`);
    print(`  ${c.cyan}bun install${c.reset}`);
    print(`  ${c.cyan}npx playwright install chromium${c.reset}`);
    print(`  ${c.cyan}claude mcp add ${cfg.MCP_NAME} -s user -- bun run ${REPO_ROOT}/src/channel-server.ts${c.reset}`);
    print(`  ${c.cyan}pm2 start ecosystem.config.cjs${c.reset}`);
    return;
  }

  // 1. bun install
  br();
  write(`${c.dim}▶${c.reset} bun install… `);
  const bi = await run(["bun", "install"], { cwd: REPO_ROOT });
  if (bi.ok) print(`${c.green}✓${c.reset}`);
  else {
    print(`${c.red}✗${c.reset}`);
    print(bi.err);
    fail("bun install 失败，请自己看错误重试");
    return;
  }

  // 2. playwright
  write(`${c.dim}▶${c.reset} playwright install chromium… `);
  const pw = await run(["bunx", "playwright", "install", "chromium"], { cwd: REPO_ROOT });
  if (pw.ok) print(`${c.green}✓${c.reset}`);
  else {
    print(`${c.yellow}⚠${c.reset}  跳过（截图功能会不可用）`);
  }

  // 3. MCP register
  write(`${c.dim}▶${c.reset} claude mcp add ${cfg.MCP_NAME}… `);
  // 先尝试删除旧的（忽略错误）
  await run(["claude", "mcp", "remove", cfg.MCP_NAME, "-s", "user"]);
  const mcp = await run([
    "claude", "mcp", "add", cfg.MCP_NAME, "-s", "user",
    "--", "bun", "run", `${REPO_ROOT}/src/channel-server.ts`,
  ]);
  if (mcp.ok) print(`${c.green}✓${c.reset}`);
  else {
    print(`${c.red}✗${c.reset}`);
    print(mcp.err || mcp.out);
    warn("MCP 注册失败，你可能需要手动跑这条命令");
  }

  // 4. pm2 start
  write(`${c.dim}▶${c.reset} pm2 start ecosystem.config.cjs… `);
  const pm2 = await run(["pm2", "start", "ecosystem.config.cjs"], { cwd: REPO_ROOT });
  if (pm2.ok) {
    print(`${c.green}✓${c.reset}`);
    await run(["pm2", "save"], { cwd: REPO_ROOT });
  } else {
    print(`${c.red}✗${c.reset}`);
    print(pm2.err || pm2.out);
    warn("pm2 启动失败，试试: pm2 logs");
  }
}

// ============================================================
// 完成
// ============================================================

function stepDone(cfg: Config): void {
  br();
  print(`${c.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  print(`${c.bold}${c.green}  ✨ 安装完成！${c.reset}`);
  print(`${c.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  br();
  print(`${c.bold}试一下:${c.reset}`);
  print(`  ${c.dim}①${c.reset} 打开 Discord，去你的 ${c.yellow}#控制频道${c.reset}`);
  print(`  ${c.dim}②${c.reset} 发一句话给 bot（${c.dim}比如 "你好"${c.reset}）`);
  print(`  ${c.dim}③${c.reset} 几秒内 ${c.yellow}${cfg.USER_NAME}${c.reset} 就会回你 + 给你一个按钮菜单`);
  br();
  print(`${c.bold}如果没反应:${c.reset}`);
  print(`  ${c.cyan}pm2 logs discord-bridge${c.reset}  ${c.dim}(看 bridge 日志)${c.reset}`);
  print(`  ${c.cyan}pm2 logs master-launcher${c.reset} ${c.dim}(看大总管启动日志)${c.reset}`);
  br();
  print(`${c.bold}开机自启（推荐跑一次）:${c.reset}`);
  print(`  ${c.cyan}pm2 startup${c.reset}  ${c.dim}(它会打印一条 sudo 命令，复制跑一下)${c.reset}`);
  print(`  ${c.cyan}pm2 save${c.reset}`);
  br();
  print(`祝你玩得愉快 ${c.yellow}🎉${c.reset}`);
  br();
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  print("");
  print(`${c.bold}${c.cyan}   ░█▀▀░█░░░█▀█░█░█░█▀▄░█▀▀░█▀▀░▀█▀░█▀▄░█▀█${c.reset}`);
  print(`${c.bold}${c.cyan}   ░█░░░█░░░█▀█░█░█░█░█░█▀▀░▀▀█░░█░░█▀▄░█▀█${c.reset}`);
  print(`${c.bold}${c.cyan}   ░▀▀▀░▀▀▀░▀░▀░▀▀▀░▀▀░░▀▀▀░▀▀▀░░▀░░▀░▀░▀░▀${c.reset}`);
  print("");
  print(`   ${c.dim}从手机 Discord 管理本地 Claude Code session${c.reset}`);
  print(`   ${c.dim}接下来 8 个步骤，大概 10 分钟搞定${c.reset}`);
  print("");

  // 读现有 .env 作为默认值
  let existing: Partial<Config> = {};
  if (await fileExists(ENV_PATH)) {
    existing = parseEnv(await readFile(ENV_PATH, "utf-8"));
  } else if (await fileExists(ENV_EXAMPLE_PATH)) {
    existing = parseEnv(await readFile(ENV_EXAMPLE_PATH, "utf-8"));
  }

  await stepCheckDeps();
  await stepCreateApp();
  const token = await stepGetToken();
  await stepIntents();
  await stepInviteBot();
  const { guildId, userId, controlChannelId } = await stepCollectIds();
  const { userName, mcpName, bridgePort } = await stepPreferences(existing);

  const cfg: Config = {
    DISCORD_BOT_TOKEN: token,
    DISCORD_GUILD_ID: guildId,
    ALLOWED_USER_IDS: userId,
    CONTROL_CHANNEL_ID: controlChannelId,
    BRIDGE_PORT: bridgePort,
    USER_NAME: userName,
    MCP_NAME: mcpName,
  };

  await stepFinalize(cfg);
  stepDone(cfg);

  process.exit(0);
}

main().catch((err) => {
  print("");
  fail("安装向导出错: " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
