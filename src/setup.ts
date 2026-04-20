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
import { constants, readSync, openSync } from "fs";
import { resolve } from "path";
import { printTmuxGuide } from "./lib/tmux-guide.js";

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

// stdin 如果不是 TTY（curl|bash → bun run 嵌套 spawn 子进程时 stdin 是空 pipe），
// 直接 openSync("/dev/tty") 拿到控制终端的 fd 来读。
let INPUT_FD = 0;
if (!process.stdin.isTTY) {
  try {
    INPUT_FD = openSync("/dev/tty", "r");
  } catch {
    console.error("❌ 无法打开终端输入，请直接运行: bun run setup");
    process.exit(1);
  }
}

// 同步阻塞读，逐字节到换行符。直接走 POSIX read(2)，不依赖事件循环。
function readLine(): Promise<string> {
  const buf = Buffer.alloc(1);
  let line = "";
  while (true) {
    let n: number;
    try {
      n = readSync(INPUT_FD, buf, 0, 1, null);
    } catch {
      break;
    }
    if (n === 0) break;
    const ch = buf.toString("utf-8");
    if (ch === "\n") return Promise.resolve(line);
    if (ch !== "\r") line += ch;
  }
  if (line.length > 0) return Promise.resolve(line);
  console.error("\n❌ 输入已关闭（stdin EOF）");
  process.exit(1);
}

async function waitEnter(msg = "完成后按 ENTER 继续") {
  write(`${c.dim}  ${msg}…${c.reset}`);
  await readLine();
}

async function prompt(
  label: string,
  defaultValue?: string,
  validator?: (v: string) => string | null
): Promise<string> {
  while (true) {
    const hint = defaultValue ? ` ${c.dim}[${defaultValue}]${c.reset}` : "";
    write(`${c.bold}${label}${c.reset}${hint}: `);
    const answer = (await readLine()).trim() || defaultValue || "";
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
// 步骤 1：依赖检查 + 自动安装
// ============================================================

type InstallerKind = "brew" | "apt" | "npm" | "curl-bun";

interface DepSpec {
  cmd: string;
  label: string;
  /** 平台 → 安装方式 */
  installers: Partial<Record<"darwin" | "linux", { kind: InstallerKind; pkg?: string; script?: string }>>;
  /** 给不支持自动安装的用户看的手动命令 */
  manual: string;
}

const DEPS: DepSpec[] = [
  {
    cmd: "git",
    label: "git",
    installers: {
      darwin: { kind: "brew", pkg: "git" },
      linux: { kind: "apt", pkg: "git" },
    },
    manual: "brew install git （或系统自带）",
  },
  {
    cmd: "tmux",
    label: "tmux",
    installers: {
      darwin: { kind: "brew", pkg: "tmux" },
      linux: { kind: "apt", pkg: "tmux" },
    },
    manual: "brew install tmux",
  },
  {
    cmd: "node",
    label: "node (npm 的前置)",
    installers: {
      darwin: { kind: "brew", pkg: "node" },
      linux: { kind: "apt", pkg: "nodejs" },
    },
    manual: "brew install node",
  },
  {
    cmd: "bun",
    label: "bun",
    installers: {
      darwin: { kind: "curl-bun" },
      linux: { kind: "curl-bun" },
    },
    manual: "curl -fsSL https://bun.sh/install | bash",
  },
  {
    cmd: "pm2",
    label: "pm2",
    installers: {
      darwin: { kind: "npm", pkg: "pm2" },
      linux: { kind: "npm", pkg: "pm2" },
    },
    manual: "npm install -g pm2",
  },
  {
    cmd: "claude",
    label: "claude (Claude Code CLI)",
    installers: {
      darwin: { kind: "npm", pkg: "@anthropic-ai/claude-code" },
      linux: { kind: "npm", pkg: "@anthropic-ai/claude-code" },
    },
    manual: "npm install -g @anthropic-ai/claude-code",
  },
];

async function runInstaller(installer: { kind: InstallerKind; pkg?: string; script?: string }): Promise<boolean> {
  switch (installer.kind) {
    case "brew": {
      const proc = Bun.spawn(["brew", "install", installer.pkg!], { stdout: "inherit", stderr: "inherit" });
      return (await proc.exited) === 0;
    }
    case "apt": {
      const proc = Bun.spawn(["sudo", "apt-get", "install", "-y", installer.pkg!], { stdout: "inherit", stderr: "inherit" });
      return (await proc.exited) === 0;
    }
    case "npm": {
      const proc = Bun.spawn(["npm", "install", "-g", installer.pkg!], { stdout: "inherit", stderr: "inherit" });
      return (await proc.exited) === 0;
    }
    case "curl-bun": {
      // 用 bash -c 执行 curl | bash，然后把 ~/.bun/bin 加到 PATH（仅当前进程）
      const script = 'curl -fsSL https://bun.sh/install | bash';
      const proc = Bun.spawn(["bash", "-c", script], { stdout: "inherit", stderr: "inherit" });
      const code = await proc.exited;
      if (code === 0) {
        process.env.PATH = `${process.env.HOME}/.bun/bin:${process.env.PATH || ""}`;
      }
      return code === 0;
    }
  }
}

async function stepCheckDeps(): Promise<void> {
  header(1, "检查系统依赖 + 自动安装");

  const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  if (!platform) {
    fail(`不支持的系统: ${process.platform}。Claudestra 只支持 macOS 和 Linux`);
    process.exit(1);
  }

  // 先扫一遍
  print("扫描依赖:");
  br();

  const status: Array<{ dep: DepSpec; has: boolean }> = [];
  for (const dep of DEPS) {
    const has = await which(dep.cmd);
    status.push({ dep, has });
    if (has) ok(`${c.bold}${dep.label}${c.reset}`);
    else fail(`${c.bold}${dep.label}${c.reset} — 未安装`);
  }

  const missing = status.filter((s) => !s.has);
  if (missing.length === 0) {
    br();
    ok("所有依赖就绪 ✨");
    return;
  }

  br();
  warn(`缺少 ${missing.length} 个依赖。我可以帮你装。`);
  br();

  // 前置检查：macOS 需要 brew；Linux 需要 apt + sudo
  if (platform === "darwin") {
    const hasBrew = await which("brew");
    const needsBrew = missing.some((m) => m.dep.installers.darwin?.kind === "brew");
    if (needsBrew && !hasBrew) {
      fail("macOS 自动安装需要 Homebrew，但你没装。");
      hint("先装 Homebrew:");
      print(`  ${c.cyan}/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"${c.reset}`);
      br();
      hint("装完 brew 后重跑: bun run setup");
      process.exit(1);
    }
  } else {
    const hasApt = await which("apt-get");
    const needsApt = missing.some((m) => m.dep.installers.linux?.kind === "apt");
    if (needsApt && !hasApt) {
      fail("Linux 自动安装目前只支持 apt-get (Debian/Ubuntu)。");
      hint("你的系统上请手动安装：");
      for (const m of missing) hint(`  ${m.dep.label}: ${m.dep.manual}`);
      process.exit(1);
    }
  }

  print(`${c.bold}计划安装：${c.reset}`);
  for (const m of missing) {
    const installer = m.dep.installers[platform];
    const how = installer?.kind === "brew" ? `brew install ${installer.pkg}` :
                installer?.kind === "apt" ? `sudo apt-get install -y ${installer.pkg}` :
                installer?.kind === "npm" ? `npm install -g ${installer.pkg}` :
                installer?.kind === "curl-bun" ? "curl -fsSL https://bun.sh/install | bash" :
                m.dep.manual;
    print(`  ${c.dim}•${c.reset} ${c.bold}${m.dep.label}${c.reset}  ${c.dim}→ ${how}${c.reset}`);
  }
  br();

  if (!(await confirm("开始安装？", true))) {
    warn("已取消。你可以手动跑上面的命令，然后重跑 bun run setup");
    process.exit(1);
  }

  br();
  // 逐个安装。node 必须在 npm 类依赖之前，DEPS 已排好序
  for (const m of missing) {
    const installer = m.dep.installers[platform];
    if (!installer) {
      fail(`${m.dep.label}: 当前系统不支持自动安装，手动跑: ${m.dep.manual}`);
      continue;
    }

    br();
    print(`${c.cyan}▶${c.reset} 安装 ${c.bold}${m.dep.label}${c.reset}…`);
    const success = await runInstaller(installer);
    if (success) {
      // 重新验证 which 能不能找到（PATH 可能刚更新）
      const nowHas = await which(m.dep.cmd);
      if (nowHas) {
        ok(`${m.dep.label} 安装成功`);
      } else {
        warn(`${m.dep.label} 安装返回成功但 shell 找不到命令`);
        hint(`可能需要新开一个终端让 PATH 生效，或重跑 bun run setup`);
      }
    } else {
      fail(`${m.dep.label} 安装失败`);
      hint(`手动跑: ${m.dep.manual}`);
    }
  }

  // 最后再验证一次
  br();
  print("复查依赖:");
  let stillMissing = 0;
  for (const dep of DEPS) {
    const has = await which(dep.cmd);
    if (has) ok(`${c.bold}${dep.label}${c.reset}`);
    else {
      fail(`${c.bold}${dep.label}${c.reset} — 仍然没装上`);
      stillMissing++;
    }
  }

  if (stillMissing > 0) {
    br();
    fail(`${stillMissing} 个依赖没装上，向导没法继续`);
    hint("检查上面的错误，手动装完后重跑 bun run setup");
    process.exit(1);
  }

  br();
  ok("系统依赖就绪 ✨");
}

// ============================================================
// 步骤 2：创建 Discord 应用
// ============================================================

async function stepCreateApp(): Promise<string> {
  header(2, "创建 Discord 应用");

  print("要让 bot 进你的服务器，先在 Discord 开发者门户创建一个应用。");
  br();
  hint("开发者门户按 Discord 账号语言显示。下面英文按钮后面带的 / 中文 是中文 UI 里对应的名字。");
  br();

  step("①", `打开浏览器: ${url("https://discord.com/developers/applications")}`);
  step("②", `点右上角 ${c.bold}${c.green}New Application${c.reset} / ${c.green}新建应用${c.reset}（绿色按钮）`);
  step("③", `起个名字 —— ${c.yellow}claudestra${c.reset} 或你喜欢的任何名字`);
  step("④", `勾选同意条款 → 点 ${c.bold}Create${c.reset} / ${c.bold}创建${c.reset}`);

  br();
  print(`创建成功后，浏览器地址栏会像这样：`);
  print(`  ${c.dim}https://discord.com/developers/applications/${c.cyan}1485860782322356244${c.reset}${c.dim}/information${c.reset}`);
  print(`中间那一串 18-20 位数字就是 ${c.bold}Application ID${c.reset}。下面直接给你生成深链，少点几步。`);
  br();

  const raw = await promptRequired(`${kbd("粘贴 Application ID 或整条 URL")}`, (v) => {
    return /\d{17,20}/.test(v) ? null : "没找到 17-20 位的 Application ID";
  });
  const appId = raw.match(/\d{17,20}/)![0];
  ok(`Application ID 收到: ${appId}`);
  return appId;
}

// ============================================================
// 步骤 3：获取 Bot Token
// ============================================================

async function stepGetToken(appId: string): Promise<string> {
  header(3, "获取 Bot Token");

  print("Bot token 是 bot 的身份凭证。别告诉任何人，更别传到 GitHub。");
  br();

  step("①", `直接点这个深链打开 Bot 页面: ${url(`https://discord.com/developers/applications/${appId}/bot`)}`);
  step("②", `如果提示 Add Bot / 添加机器人，点 ${c.bold}Yes, do it!${c.reset} / ${c.bold}好的${c.reset}`);
  step("③", `点 ${c.bold}${c.red}Reset Token${c.reset} / ${c.red}重置令牌${c.reset}（可能需要 2FA 确认）`);
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

async function stepIntents(appId: string): Promise<void> {
  header(4, "开启 Privileged Intents");

  print("Discord 对敏感 API 有三个 intent 开关，bot 必须全部打开才能正常工作。");
  br();

  step("①", `直接点这个深链回到 Bot 页面: ${url(`https://discord.com/developers/applications/${appId}/bot`)}，往下滚到 ${c.bold}Privileged Gateway Intents${c.reset} / ${c.bold}特权网关 Intent${c.reset} 区块`);
  step("②", `把这三个开关全部打开（这三个名字 Discord 中英文 UI 都是英文）：`);
  print(`     ${c.green}▢${c.reset} → ${c.green}▣${c.reset} ${c.bold}PRESENCE INTENT${c.reset}`);
  print(`     ${c.green}▢${c.reset} → ${c.green}▣${c.reset} ${c.bold}SERVER MEMBERS INTENT${c.reset}`);
  print(`     ${c.green}▢${c.reset} → ${c.green}▣${c.reset} ${c.bold}MESSAGE CONTENT INTENT${c.reset}`);
  step("③", `点页面底部的 ${c.bold}${c.green}Save Changes${c.reset} / ${c.green}保存更改${c.reset}`);

  br();
  warn("少一个 intent，bot 都会静默忽略消息 —— 不会报错，只是没反应");
  br();
  await waitEnter();
}

// ============================================================
// 步骤 5：邀请 Bot 到服务器
// ============================================================

async function stepInviteBot(appId: string): Promise<void> {
  header(5, "邀请 Bot 到你的服务器");

  print("生成一个邀请链接，把 bot 拉进你要管理的 Discord 服务器。");
  br();
  hint(`还没有 Discord 服务器？先在 Discord 主界面左边 ${c.bold}+${c.reset} 号点一下 → ${c.bold}亲自创建${c.reset} / ${c.bold}Create My Own${c.reset} → 给自己和朋友 → 起个名字。下面再回来继续。`);
  br();

  step("①", `直接点深链到 URL Generator: ${url(`https://discord.com/developers/applications/${appId}/oauth2/url-generator`)}`);

  br();
  step("②", `${c.bold}SCOPES${c.reset} / ${c.bold}范围${c.reset} 勾选这两个：`);
  print(`     ${c.green}▣${c.reset} bot`);
  print(`     ${c.green}▣${c.reset} applications.commands`);

  br();
  step("③", `${c.bold}BOT PERMISSIONS${c.reset} / ${c.bold}机器人权限${c.reset} 勾选这 7 个（中文 UI 名字写在括号里）：`);
  print(`     ${c.green}▣${c.reset} View Channels ${c.dim}(查看频道)${c.reset}`);
  print(`     ${c.green}▣${c.reset} Send Messages ${c.dim}(发送消息)${c.reset}`);
  print(`     ${c.green}▣${c.reset} Read Message History ${c.dim}(阅读消息历史)${c.reset}`);
  print(`     ${c.green}▣${c.reset} ${c.yellow}Manage Channels${c.reset} ${c.dim}(管理频道 — bridge 要自动建 agent 频道)${c.reset}`);
  print(`     ${c.green}▣${c.reset} Attach Files ${c.dim}(附加文件)${c.reset}`);
  print(`     ${c.green}▣${c.reset} Add Reactions ${c.dim}(添加反应)${c.reset}`);
  print(`     ${c.green}▣${c.reset} Embed Links ${c.dim}(嵌入链接)${c.reset}`);

  br();
  step("④", `复制页面最底部的 ${c.bold}GENERATED URL${c.reset} / ${c.bold}生成的 URL${c.reset}`);
  step("⑤", `在浏览器打开那个 URL → 选择你的服务器 → ${c.bold}${c.green}授权${c.reset} / ${c.green}Authorize${c.reset}`);

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
  const mcpName = await prompt(
    `${kbd("MCP 服务名")} ${c.dim}(只能用英文字母/数字/-/_；不能用中文，claude mcp add 会拒绝)${c.reset}`,
    existing.MCP_NAME || "claudestra",
    (v) => /^[A-Za-z0-9_-]+$/.test(v) ? null : "非法：只能用英文字母、数字、- 和 _，不能有中文/空格/其他字符"
  );
  const bridgePort = await prompt(
    `${kbd("Bridge 端口")}`,
    existing.BRIDGE_PORT || "3847",
    (v) => /^\d{1,5}$/.test(v) && +v > 0 && +v < 65536 ? null : "端口必须是 1-65535 的整数"
  );

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

/** 把 typing hook 写入 ~/.claude/settings.json */
async function registerHooks(hookCmd: string): Promise<void> {
  const settingsPath = `${process.env.HOME}/.claude/settings.json`;
  let settings: any = {};
  if (await fileExists(settingsPath)) {
    settings = JSON.parse(await readFile(settingsPath, "utf-8"));
  }
  if (!settings.hooks) settings.hooks = {};

  const hookEntry = {
    matcher: "",
    hooks: [{ type: "command", command: hookCmd }],
  };

  for (const event of ["Stop", "StopFailure", "Notification"]) {
    const existing: any[] = settings.hooks[event] || [];
    // 如果已有相同命令的 hook，跳过
    const alreadyRegistered = existing.some((e: any) =>
      e.hooks?.some((h: any) => h.command === hookCmd)
    );
    if (!alreadyRegistered) {
      existing.push(hookEntry);
    }
    settings.hooks[event] = existing;
  }

  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
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
  print(`  ${c.dim}•${c.reset} ${c.cyan}注册 typing hooks${c.reset}  ${c.dim}(写入 ~/.claude/settings.json)${c.reset}`);
  print(`  ${c.dim}•${c.reset} ${c.cyan}pm2 start ecosystem.config.cjs${c.reset}  ${c.dim}(启动服务)${c.reset}`);
  br();

  if (!(await confirm("要我一键帮你跑完吗？", true))) {
    br();
    ok("配置已保存。剩下的命令自己跑：");
    print(`  ${c.cyan}cd ${REPO_ROOT}${c.reset}`);
    print(`  ${c.cyan}bun install${c.reset}`);
    print(`  ${c.cyan}npx playwright install chromium${c.reset}`);
    print(`  ${c.cyan}claude mcp add ${cfg.MCP_NAME} -s user -- bun run ${REPO_ROOT}/src/channel-server.ts${c.reset}`);
    print(`  ${c.dim}# typing hooks: 手动编辑 ~/.claude/settings.json，或重跑 bun run setup${c.reset}`);
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

  // 4. hooks (typing indicator) — 直接写 ~/.claude/settings.json
  const hookCmd = `bun ${REPO_ROOT}/src/hooks/typing-hook.ts`;
  write(`${c.dim}▶${c.reset} 注册 typing hooks… `);
  try {
    await registerHooks(hookCmd);
    print(`${c.green}✓${c.reset}`);
  } catch (e: any) {
    print(`${c.yellow}⚠${c.reset}`);
    warn(`hook 注册失败: ${e.message}`);
    hint("typing 指示器可能不会自动停止，需手动编辑 ~/.claude/settings.json");
  }

  // 5. pm2 start
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

  // tmux 教程
  printTmuxGuide();

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
  const appId = await stepCreateApp();
  const token = await stepGetToken(appId);
  await stepIntents(appId);
  await stepInviteBot(appId);
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
