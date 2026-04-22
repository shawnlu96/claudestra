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

// ============================================================
// 语言切换 / i18n
// ============================================================
// 全局 lang 变量。main() 开头第 0 步让用户选，默认中文。
// 后续每个用户面对的字符串用 t(zh, en) 返回对应语言。
let lang: "zh" | "en" = "zh";
function t(zh: string, en: string): string {
  return lang === "en" ? en : zh;
}

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
    // 语言还没选，所以这条必须双语
    console.error("❌ Cannot open terminal input. Run directly: bun run setup\n❌ 无法打开终端输入，请直接运行: bun run setup");
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
  console.error(t("\n❌ 输入已关闭（stdin EOF）", "\n❌ Input closed (stdin EOF)"));
  process.exit(1);
}

async function waitEnter(msg?: string) {
  const m = msg ?? t("完成后按 ENTER 继续", "Press ENTER when done");
  write(`${c.dim}  ${m}…${c.reset}`);
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
      fail(t("这项必填，再试一次", "This field is required — try again"));
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
    return t(
      "Discord ID 应该是 17-20 位数字。你是不是复制错了？（记得开启开发者模式右键 → 复制 ID）",
      "Discord ID should be 17-20 digits. Did you copy the wrong thing? (Enable Developer Mode → right-click → Copy ID)",
    );
  }
  return null;
}

function validateToken(v: string): string | null {
  if (v.length < 30) {
    return t("token 看起来太短。Discord bot token 至少 50+ 字符", "Token looks too short. Discord bot token is 50+ chars");
  }
  if (v.includes(" ")) {
    return t("token 不应该包含空格，是不是多复制了东西？", "Token should not contain spaces — did you copy extra?");
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
  header(1, t("检查系统依赖 + 自动安装", "Check system dependencies + auto-install"));

  const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  if (!platform) {
    fail(t(`不支持的系统: ${process.platform}。Claudestra 只支持 macOS 和 Linux`, `Unsupported OS: ${process.platform}. Claudestra supports macOS and Linux only`));
    process.exit(1);
  }

  // 先扫一遍
  print(t("扫描依赖:", "Scanning dependencies:"));
  br();

  const status: Array<{ dep: DepSpec; has: boolean }> = [];
  for (const dep of DEPS) {
    const has = await which(dep.cmd);
    status.push({ dep, has });
    if (has) ok(`${c.bold}${dep.label}${c.reset}`);
    else fail(`${c.bold}${dep.label}${c.reset} — ${t("未安装", "not installed")}`);
  }

  const missing = status.filter((s) => !s.has);
  if (missing.length === 0) {
    br();
    ok(t("所有依赖就绪 ✨", "All dependencies ready ✨"));
    return;
  }

  br();
  warn(t(`缺少 ${missing.length} 个依赖。我可以帮你装。`, `Missing ${missing.length} dependencies. I can install them for you.`));
  br();

  // 前置检查：macOS 需要 brew；Linux 需要 apt + sudo
  if (platform === "darwin") {
    const hasBrew = await which("brew");
    const needsBrew = missing.some((m) => m.dep.installers.darwin?.kind === "brew");
    if (needsBrew && !hasBrew) {
      fail(t("macOS 自动安装需要 Homebrew，但你没装。", "macOS auto-install needs Homebrew, but you don't have it."));
      hint(t("先装 Homebrew:", "Install Homebrew first:"));
      print(`  ${c.cyan}/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"${c.reset}`);
      br();
      hint(t("装完 brew 后重跑: bun run setup", "After brew is installed, rerun: bun run setup"));
      process.exit(1);
    }
  } else {
    const hasApt = await which("apt-get");
    const needsApt = missing.some((m) => m.dep.installers.linux?.kind === "apt");
    if (needsApt && !hasApt) {
      fail(t("Linux 自动安装目前只支持 apt-get (Debian/Ubuntu)。", "Linux auto-install currently supports apt-get only (Debian/Ubuntu)."));
      hint(t("你的系统上请手动安装：", "On your system, install manually:"));
      for (const m of missing) hint(`  ${m.dep.label}: ${m.dep.manual}`);
      process.exit(1);
    }
  }

  print(`${c.bold}${t("计划安装：", "Plan:")}${c.reset}`);
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

  if (!(await confirm(t("开始安装？", "Start installing?"), true))) {
    warn(t("已取消。你可以手动跑上面的命令，然后重跑 bun run setup", "Cancelled. You can run the commands above manually, then rerun bun run setup"));
    process.exit(1);
  }

  br();
  // 逐个安装。node 必须在 npm 类依赖之前，DEPS 已排好序
  for (const m of missing) {
    const installer = m.dep.installers[platform];
    if (!installer) {
      fail(t(`${m.dep.label}: 当前系统不支持自动安装，手动跑: ${m.dep.manual}`, `${m.dep.label}: auto-install not supported on this OS — run manually: ${m.dep.manual}`));
      continue;
    }

    br();
    print(`${c.cyan}▶${c.reset} ${t("安装", "Installing")} ${c.bold}${m.dep.label}${c.reset}…`);
    const success = await runInstaller(installer);
    if (success) {
      // 重新验证 which 能不能找到（PATH 可能刚更新）
      const nowHas = await which(m.dep.cmd);
      if (nowHas) {
        ok(t(`${m.dep.label} 安装成功`, `${m.dep.label} installed`));
      } else {
        warn(t(`${m.dep.label} 安装返回成功但 shell 找不到命令`, `${m.dep.label} install reported success but shell can't find it`));
        hint(t(`可能需要新开一个终端让 PATH 生效，或重跑 bun run setup`, `Open a new terminal for PATH to take effect, or rerun bun run setup`));
      }
    } else {
      fail(t(`${m.dep.label} 安装失败`, `${m.dep.label} install failed`));
      hint(t(`手动跑: ${m.dep.manual}`, `Run manually: ${m.dep.manual}`));
    }
  }

  // 最后再验证一次
  br();
  print(t("复查依赖:", "Re-checking dependencies:"));
  let stillMissing = 0;
  for (const dep of DEPS) {
    const has = await which(dep.cmd);
    if (has) ok(`${c.bold}${dep.label}${c.reset}`);
    else {
      fail(`${c.bold}${dep.label}${c.reset} — ${t("仍然没装上", "still missing")}`);
      stillMissing++;
    }
  }

  if (stillMissing > 0) {
    br();
    fail(t(`${stillMissing} 个依赖没装上，向导没法继续`, `${stillMissing} dependencies still missing — wizard can't continue`));
    hint(t("检查上面的错误，手动装完后重跑 bun run setup", "Check the errors above, install manually, then rerun bun run setup"));
    process.exit(1);
  }

  br();
  ok(t("系统依赖就绪 ✨", "System dependencies ready ✨"));
}

// ============================================================
// 步骤 2：创建 Discord 应用
// ============================================================

async function stepCreateApp(): Promise<string> {
  header(2, t("创建 Discord 应用", "Create Discord application"));

  print(t("要让 bot 进你的服务器，先在 Discord 开发者门户创建一个应用。", "To add a bot to your server, first create an application in the Discord Developer Portal."));
  br();
  hint(t(
    "开发者门户按 Discord 账号语言显示。下面英文按钮后面带的 / 中文 是中文 UI 里对应的名字。",
    "The Developer Portal is localised by your Discord account language. Below, the English button labels and their Chinese equivalents are both shown.",
  ));
  br();

  step("①", t(`打开浏览器: ${url("https://discord.com/developers/applications")}`, `Open in browser: ${url("https://discord.com/developers/applications")}`));
  step("②", t(
    `点右上角 ${c.bold}${c.green}New Application${c.reset} / ${c.green}新建应用${c.reset}（绿色按钮）`,
    `Click ${c.bold}${c.green}New Application${c.reset} in the top right (green button)`,
  ));
  step("③", t(
    `起个名字 —— ${c.yellow}claudestra${c.reset} 或你喜欢的任何名字`,
    `Name it — ${c.yellow}claudestra${c.reset} or whatever you like`,
  ));
  step("④", t(
    `勾选同意条款 → 点 ${c.bold}Create${c.reset} / ${c.bold}创建${c.reset}`,
    `Check the terms → click ${c.bold}Create${c.reset}`,
  ));

  br();
  print(t(`创建成功后，浏览器地址栏会像这样：`, `After creation, your browser URL will look like:`));
  print(`  ${c.dim}https://discord.com/developers/applications/${c.cyan}1485860782322356244${c.reset}${c.dim}/information${c.reset}`);
  print(t(
    `中间那一串 18-20 位数字就是 ${c.bold}Application ID${c.reset}。下面直接给你生成深链，少点几步。`,
    `The 18-20 digit string in the middle is your ${c.bold}Application ID${c.reset}. We'll use it to generate deep links so you save a few clicks.`,
  ));
  br();

  const raw = await promptRequired(
    kbd(t("粘贴 Application ID 或整条 URL", "Paste Application ID or the full URL")),
    (v) => (/\d{17,20}/.test(v) ? null : t("没找到 17-20 位的 Application ID", "Could not find a 17-20 digit Application ID")),
  );
  const appId = raw.match(/\d{17,20}/)![0];
  ok(t(`Application ID 收到: ${appId}`, `Application ID received: ${appId}`));
  return appId;
}

// ============================================================
// 步骤 3：获取 Bot Token
// ============================================================

async function stepGetToken(appId: string): Promise<string> {
  header(3, t("获取 Bot Token", "Get the Bot Token"));

  print(t("Bot token 是 bot 的身份凭证。别告诉任何人，更别传到 GitHub。", "The bot token is your bot's credential. Don't share it, don't commit it to GitHub."));
  br();

  step("①", t(
    `直接点这个深链打开 Bot 页面: ${url(`https://discord.com/developers/applications/${appId}/bot`)}`,
    `Open the Bot page directly: ${url(`https://discord.com/developers/applications/${appId}/bot`)}`,
  ));
  step("②", t(
    `如果提示 Add Bot / 添加机器人，点 ${c.bold}Yes, do it!${c.reset} / ${c.bold}好的${c.reset}`,
    `If prompted to Add Bot, click ${c.bold}Yes, do it!${c.reset}`,
  ));
  step("③", t(
    `点 ${c.bold}${c.red}Reset Token${c.reset} / ${c.red}重置令牌${c.reset}（可能需要 2FA 确认）`,
    `Click ${c.bold}${c.red}Reset Token${c.reset} (2FA may be required)`,
  ));
  step("④", t(
    `${c.bold}${c.green}立即复制${c.reset}弹出的 token —— 它只显示一次！`,
    `${c.bold}${c.green}Copy the token immediately${c.reset} — it's shown only once!`,
  ));

  br();
  warn(t(
    "token 格式类似 " + c.dim + "MTIzNDU2Nzg5MDEyMzQ1Njc4.XXXXXXX.YYYYY..." + c.reset,
    "Token looks like " + c.dim + "MTIzNDU2Nzg5MDEyMzQ1Njc4.XXXXXXX.YYYYY..." + c.reset,
  ));
  br();

  const token = await promptRequired(kbd(t("粘贴 token", "Paste token")), validateToken);
  ok(t("token 收到", "Token received"));
  return token;
}

// ============================================================
// 步骤 4：开启 Privileged Intents
// ============================================================

async function stepIntents(appId: string): Promise<void> {
  header(4, t("开启 Privileged Intents", "Enable Privileged Intents"));

  print(t(
    "Discord 对敏感 API 有三个 intent 开关，bot 必须全部打开才能正常工作。",
    "Discord has three intent toggles for sensitive APIs. The bot needs all three enabled to work.",
  ));
  br();

  step("①", t(
    `直接点这个深链回到 Bot 页面: ${url(`https://discord.com/developers/applications/${appId}/bot`)}，往下滚到 ${c.bold}Privileged Gateway Intents${c.reset} / ${c.bold}特权网关 Intent${c.reset} 区块`,
    `Open the Bot page: ${url(`https://discord.com/developers/applications/${appId}/bot`)} and scroll to the ${c.bold}Privileged Gateway Intents${c.reset} section`,
  ));
  step("②", t(
    `把这三个开关全部打开（这三个名字 Discord 中英文 UI 都是英文）：`,
    `Enable all three toggles (names below are the same in all Discord UI languages):`,
  ));
  print(`     ${c.green}▢${c.reset} → ${c.green}▣${c.reset} ${c.bold}PRESENCE INTENT${c.reset}`);
  print(`     ${c.green}▢${c.reset} → ${c.green}▣${c.reset} ${c.bold}SERVER MEMBERS INTENT${c.reset}`);
  print(`     ${c.green}▢${c.reset} → ${c.green}▣${c.reset} ${c.bold}MESSAGE CONTENT INTENT${c.reset}`);
  step("③", t(
    `点页面底部的 ${c.bold}${c.green}Save Changes${c.reset} / ${c.green}保存更改${c.reset}`,
    `Click ${c.bold}${c.green}Save Changes${c.reset} at the bottom`,
  ));

  br();
  warn(t(
    "少一个 intent，bot 都会静默忽略消息 —— 不会报错，只是没反应",
    "Miss any intent and the bot will silently ignore messages — no error, just no response",
  ));
  br();
  await waitEnter();
}

// ============================================================
// 步骤 5：邀请 Bot 到服务器
// ============================================================

async function stepInviteBot(appId: string): Promise<void> {
  header(5, t("邀请 Bot 到你的服务器", "Invite the bot to your server"));

  hint(t(
    `还没有 Discord 服务器？先在 Discord 主界面左边 ${c.bold}+${c.reset} 号点一下 → ${c.bold}亲自创建${c.reset} / ${c.bold}Create My Own${c.reset} → 给自己和朋友 → 起个名字。下面再回来继续。`,
    `No Discord server yet? On the Discord main UI, click the ${c.bold}+${c.reset} button on the left sidebar → ${c.bold}Create My Own${c.reset} → For me and my friends → give it a name. Then come back here.`,
  ));
  br();

  // 直接拼好邀请 URL（完整权限：View / Send / ReadHistory / ManageChannels / ManageRoles / AttachFiles / AddReactions / EmbedLinks）
  // ManageRoles (v1.8.5+) 让我方 bot 能自动收紧 peer bot 的 role 权限，防止它默认看到所有公开频道
  const OWNER_PERMS =
    (1 << 10) + (1 << 11) + (1 << 16) + (1 << 4) + (1 << 28) + (1 << 15) + (1 << 6) + (1 << 14);
  const params = new URLSearchParams({
    client_id: appId,
    permissions: String(OWNER_PERMS),
    scope: "bot applications.commands",
  });
  const inviteUrl = `https://discord.com/api/oauth2/authorize?${params.toString()}`;

  print(t(
    `直接给你拼好了邀请链接（已经把需要的 scopes 和权限都勾上了）：`,
    `Here's the pre-configured invite URL (all required scopes and permissions already set):`,
  ));
  br();
  print(`  ${url(inviteUrl)}`);
  br();
  step("①", t(`点上面那个链接（或复制到浏览器）`, `Click the link above (or copy it into your browser)`));
  step("②", t(
    `${c.bold}ADD TO SERVER${c.reset} / ${c.bold}添加到服务器${c.reset} 下拉 → 选择你的服务器`,
    `${c.bold}ADD TO SERVER${c.reset} dropdown → select your server`,
  ));
  step("③", t(
    `${c.bold}${c.green}Authorize${c.reset} / ${c.green}授权${c.reset}（页面底部）`,
    `${c.bold}${c.green}Authorize${c.reset} (bottom of the page)`,
  ));

  br();
  hint(t(
    "授权成功后，bot 会出现在服务器成员列表里（离线状态，正常）",
    "After authorization the bot will appear in the member list (offline state, that's normal)",
  ));
  hint(t(
    `跨 Claudestra 协作（v1.8+，v1.9+ 加强版）：朋友 bot 进来后 bridge 会自动建 #agent-exchange 共享频道。${c.cyan}bun src/manager.ts invite-link --peer${c.reset} 生成最小权限邀请链接给朋友；${c.cyan}peer-expose <agent> <peer>${c.reset} 显式开放 agent 给他（默认 direct 路由，绕过 master，2-3 跳）。`,
    `Cross-Claudestra peer collaboration (v1.8+, enhanced in v1.9+): when a friend's bot joins, the bridge auto-creates a #agent-exchange channel. Use ${c.cyan}bun src/manager.ts invite-link --peer${c.reset} to generate a minimum-permission invite link for your friend, and ${c.cyan}peer-expose <agent> <peer>${c.reset} to explicitly expose an agent to them (default 'direct' routing bypasses the master, 2-3 hops total).`,
  ));
  br();
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
  header(6, t("开启开发者模式 + 收集 ID", "Enable Developer Mode + collect IDs"));

  print(t(
    "下面要从 Discord 里复制 3 个 ID。先打开开发者模式，不然右键看不到\"复制 ID\"。",
    "You need to copy 3 IDs from Discord. Enable Developer Mode first, or right-click won't show \"Copy ID\".",
  ));
  br();

  step("①", t(`Discord 左下角齿轮 → ${c.bold}用户设置${c.reset}`, `Discord bottom-left gear icon → ${c.bold}User Settings${c.reset}`));
  step("②", t(`左边栏 → ${c.bold}高级${c.reset}（App Settings 下面）`, `Left sidebar → ${c.bold}Advanced${c.reset} (under App Settings)`));
  step("③", t(`打开 ${c.bold}${c.green}开发者模式${c.reset}`, `Enable ${c.bold}${c.green}Developer Mode${c.reset}`));
  step("④", t(`关闭设置面板`, `Close the settings panel`));

  br();
  await waitEnter(t("开启开发者模式后按 ENTER", "Press ENTER after enabling Developer Mode"));

  // ── Guild ID ──
  br();
  print(`${c.bold}${c.yellow}▼ ${t("服务器 ID (Guild ID)", "Server ID (Guild ID)")}${c.reset}`);
  step("①", t(`${c.bold}右键${c.reset}左边栏顶部你的服务器图标`, `${c.bold}Right-click${c.reset} your server icon in the left sidebar`));
  step("②", t(`菜单最底部点 ${c.bold}复制服务器 ID${c.reset}`, `At the bottom of the menu, click ${c.bold}Copy Server ID${c.reset}`));
  br();
  const guildId = await promptRequired(kbd(t("粘贴服务器 ID", "Paste Server ID")), validateSnowflake);
  ok(t("服务器 ID 收到", "Server ID received"));

  // ── User ID ──
  br();
  print(`${c.bold}${c.yellow}▼ ${t("你自己的用户 ID", "Your User ID")}${c.reset}`);
  hint(t("bridge 只响应这个 ID，防止别人乱用 bot", "Bridge only responds to this ID, preventing others from using your bot"));
  step("①", t(`随便哪个频道里，${c.bold}右键${c.reset}你自己的名字`, `In any channel, ${c.bold}right-click${c.reset} your own username`));
  step("②", t(`菜单最底部点 ${c.bold}复制用户 ID${c.reset}`, `At the bottom of the menu, click ${c.bold}Copy User ID${c.reset}`));
  br();
  const userId = await promptRequired(kbd(t("粘贴你的用户 ID", "Paste your User ID")), validateSnowflake);
  ok(t("用户 ID 收到", "User ID received"));

  // ── Control Channel ──
  br();
  print(`${c.bold}${c.yellow}▼ ${t("控制频道", "Control channel")}${c.reset}`);
  print(t(
    "你还需要一个文字频道作为 \"大总管\" 的控制台。",
    "You need a text channel to serve as the master orchestrator's console.",
  ));
  step("①", t(
    `在你的服务器里建一个文字频道 —— ${c.yellow}#claudestra-control${c.reset} 或者你喜欢的任何名字`,
    `Create a text channel in your server — ${c.yellow}#claudestra-control${c.reset} or any name you like`,
  ));
  step("②", t(`${c.bold}右键${c.reset}刚建的频道 → ${c.bold}复制频道 ID${c.reset}`, `${c.bold}Right-click${c.reset} the channel → ${c.bold}Copy Channel ID${c.reset}`));
  br();
  const controlChannelId = await promptRequired(kbd(t("粘贴控制频道 ID", "Paste Control Channel ID")), validateSnowflake);
  ok(t("控制频道 ID 收到", "Control channel ID received"));

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
  header(7, t("个人偏好", "Personal preferences"));

  print(t("最后几个小问题，都有默认值，直接按 ENTER 就行。", "A few small questions. All have defaults — press ENTER to accept."));
  br();

  const userName = await promptRequired(
    `${kbd(t("你的称呼", "Your name"))} ${c.dim}${t("(大总管在 Discord 里怎么叫你)", "(how the master will address you in Discord)")}${c.reset}`,
  );
  const mcpName = await prompt(
    `${kbd(t("MCP 服务名", "MCP server name"))} ${c.dim}${t("(只能用英文字母/数字/-/_；不能用中文，claude mcp add 会拒绝)", "(letters/digits/-/_ only; no CJK — claude mcp add will reject it)")}${c.reset}`,
    existing.MCP_NAME || "claudestra",
    (v) => /^[A-Za-z0-9_-]+$/.test(v) ? null : t("非法：只能用英文字母、数字、- 和 _，不能有中文/空格/其他字符", "Invalid: letters, digits, -, _ only. No CJK/space/other chars"),
  );
  const bridgePort = await prompt(
    kbd(t("Bridge 端口", "Bridge port")),
    existing.BRIDGE_PORT || "3847",
    (v) => /^\d{1,5}$/.test(v) && +v > 0 && +v < 65536 ? null : t("端口必须是 1-65535 的整数", "Port must be an integer 1-65535"),
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
  header(8, t("写入配置 + 自动化收尾", "Write config + auto-finalize"));

  // 写 .env
  if (await fileExists(ENV_PATH)) {
    warn(t(".env 已存在", ".env already exists"));
    if (!(await confirm(t("要覆盖吗？", "Overwrite?"), false))) {
      fail(t("已取消。你现有的 .env 没被动", "Cancelled. Existing .env left untouched"));
      process.exit(1);
    }
  }
  await writeFile(ENV_PATH, buildEnvContent(cfg));
  ok(t(`写入 ${c.bold}.env${c.reset}`, `Wrote ${c.bold}.env${c.reset}`));

  // 渲染 master/CLAUDE.md
  if (await fileExists(TEMPLATE_PATH)) {
    let tpl = await readFile(TEMPLATE_PATH, "utf-8");
    tpl = tpl.replaceAll("{{USER_NAME}}", cfg.USER_NAME);
    await writeFile(RENDERED_PATH, tpl);
    ok(t(
      `渲染 ${c.bold}master/CLAUDE.md${c.reset}（你的名字: ${c.yellow}${cfg.USER_NAME}${c.reset}）`,
      `Rendered ${c.bold}master/CLAUDE.md${c.reset} (your name: ${c.yellow}${cfg.USER_NAME}${c.reset})`,
    ));
  }

  br();

  // 自动跑依赖安装 + MCP 注册 + pm2 start
  print(t("下面这些命令我可以直接帮你跑掉，一键启动:", "I can run these commands for you, one-click launch:"));
  print(`  ${c.dim}•${c.reset} ${c.cyan}bun install${c.reset}`);
  print(`  ${c.dim}•${c.reset} ${c.cyan}npx playwright install chromium${c.reset}  ${c.dim}${t("(终端截图用)", "(for terminal screenshots)")}${c.reset}`);
  print(`  ${c.dim}•${c.reset} ${c.cyan}claude mcp add ${cfg.MCP_NAME} ...${c.reset}  ${c.dim}${t("(注册 MCP server)", "(register MCP server)")}${c.reset}`);
  print(`  ${c.dim}•${c.reset} ${c.cyan}${t("注册 typing hooks", "register typing hooks")}${c.reset}  ${c.dim}${t("(写入 ~/.claude/settings.json)", "(write to ~/.claude/settings.json)")}${c.reset}`);
  print(`  ${c.dim}•${c.reset} ${c.cyan}pm2 start ecosystem.config.cjs${c.reset}  ${c.dim}${t("(启动服务)", "(start services)")}${c.reset}`);
  br();

  if (!(await confirm(t("要我一键帮你跑完吗？", "Run them all now?"), true))) {
    br();
    ok(t("配置已保存。剩下的命令自己跑：", "Config saved. Run the rest yourself:"));
    print(`  ${c.cyan}cd ${REPO_ROOT}${c.reset}`);
    print(`  ${c.cyan}bun install${c.reset}`);
    print(`  ${c.cyan}npx playwright install chromium${c.reset}`);
    print(`  ${c.cyan}claude mcp add ${cfg.MCP_NAME} -s user -- bun run ${REPO_ROOT}/src/channel-server.ts${c.reset}`);
    print(`  ${c.dim}# ${t("typing hooks: 手动编辑 ~/.claude/settings.json，或重跑 bun run setup", "typing hooks: edit ~/.claude/settings.json manually, or rerun bun run setup")}${c.reset}`);
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
    fail(t("bun install 失败，请自己看错误重试", "bun install failed — check the error above and retry"));
    return;
  }

  // 2. playwright
  write(`${c.dim}▶${c.reset} playwright install chromium… `);
  const pw = await run(["bunx", "playwright", "install", "chromium"], { cwd: REPO_ROOT });
  if (pw.ok) print(`${c.green}✓${c.reset}`);
  else {
    print(`${c.yellow}⚠${c.reset}  ${t("跳过（截图功能会不可用）", "skipped (screenshots will be unavailable)")}`);
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
    warn(t("MCP 注册失败，你可能需要手动跑这条命令", "MCP registration failed — you may need to run the command manually"));
  }

  // 4. hooks (typing indicator) — 直接写 ~/.claude/settings.json
  const hookCmd = `bun ${REPO_ROOT}/src/hooks/typing-hook.ts`;
  write(`${c.dim}▶${c.reset} ${t("注册 typing hooks", "Registering typing hooks")}… `);
  try {
    await registerHooks(hookCmd);
    print(`${c.green}✓${c.reset}`);
  } catch (e: any) {
    print(`${c.yellow}⚠${c.reset}`);
    warn(t(`hook 注册失败: ${e.message}`, `Hook registration failed: ${e.message}`));
    hint(t("typing 指示器可能不会自动停止，需手动编辑 ~/.claude/settings.json", "Typing indicator may not auto-stop. Edit ~/.claude/settings.json manually."));
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
    warn(t("pm2 启动失败，试试: pm2 logs", "pm2 start failed — try: pm2 logs"));
    return;
  }

  // 6. pm2 startup — 开机自启。需要 sudo，捕获 pm2 输出里的 sudo 命令后问用户要不要自动跑。
  write(`${c.dim}▶${c.reset} ${t("配置 pm2 开机自启", "Configure pm2 boot startup")}… `);
  const startupProbe = await run(["pm2", "startup"]);
  // pm2 startup 会输出一条 "sudo env PATH=... pm2 startup <init>" 命令
  const sudoMatch = (startupProbe.out + "\n" + (startupProbe.err || "")).match(/^\s*(sudo [^\n]+)$/m);
  if (!sudoMatch) {
    // 可能已经配置过了，或者 pm2 没给出 sudo 命令
    print(`${c.green}✓${c.reset}  ${c.dim}${t("(已配置或无需配置)", "(already configured or not required)")}${c.reset}`);
    await run(["pm2", "save"], { cwd: REPO_ROOT });
    return;
  }
  print(`${c.yellow}${t("需要 sudo", "sudo needed")}${c.reset}`);
  br();
  print(`${c.dim}${t("pm2 要写一个开机自启脚本，需要 sudo 密码。命令如下：", "pm2 needs sudo to write a boot-startup script. Command:")}${c.reset}`);
  print(`  ${c.cyan}${sudoMatch[1]}${c.reset}`);
  br();
  if (await confirm(t("要我帮你跑这条 sudo 命令吗？", "Run this sudo command for you?"), true)) {
    // 直接用 shell 跑（继承当前 TTY 让 sudo 能提示密码）
    const proc = Bun.spawn(["/bin/bash", "-c", sudoMatch[1]], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
    if (proc.exitCode === 0) {
      ok(t("pm2 开机自启已配置", "pm2 boot startup configured"));
      await run(["pm2", "save"], { cwd: REPO_ROOT });
    } else {
      warn(t("sudo 命令没成功，可以以后手工跑上面那条（或重跑 bun run setup）", "sudo command failed. Run it manually later, or rerun bun run setup"));
    }
  } else {
    hint(t(`稍后手工跑：${c.cyan}${sudoMatch[1]}${c.reset}`, `Run manually later: ${c.cyan}${sudoMatch[1]}${c.reset}`));
    hint(t(`然后再跑：${c.cyan}pm2 save${c.reset}`, `Then run: ${c.cyan}pm2 save${c.reset}`));
  }
}

// ============================================================
// 完成
// ============================================================

function stepDone(cfg: Config): void {
  br();
  print(`${c.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  print(`${c.bold}${c.green}  ✨ ${t("安装完成！", "Installation complete!")}${c.reset}`);
  print(`${c.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  br();
  print(`${c.bold}${t("试一下:", "Try it:")}${c.reset}`);
  print(`  ${c.dim}①${c.reset} ${t("打开 Discord，去你的", "Open Discord and go to your")} ${c.yellow}${t("#控制频道", "#control channel")}${c.reset}`);
  print(`  ${c.dim}②${c.reset} ${t(`发一句话给 bot（${c.dim}比如 "你好"${c.reset}）`, `Send the bot a message (${c.dim}e.g. "hi"${c.reset})`)}`);
  print(`  ${c.dim}③${c.reset} ${t(`几秒内 ${c.yellow}${cfg.USER_NAME}${c.reset} 就会回你 + 给你一个按钮菜单`, `Within seconds ${c.yellow}${cfg.USER_NAME}${c.reset} will reply with a button menu`)}`);
  br();
  print(`${c.bold}${t("如果没反应:", "If nothing happens:")}${c.reset}`);
  print(`  ${c.cyan}pm2 logs discord-bridge${c.reset}  ${c.dim}${t("(看 bridge 日志)", "(bridge logs)")}${c.reset}`);
  print(`  ${c.cyan}pm2 logs master-launcher${c.reset} ${c.dim}${t("(看大总管启动日志)", "(master launcher logs)")}${c.reset}`);
  br();
  print(`${c.bold}${t("开机自启（推荐跑一次）:", "Boot autostart (recommended):")}${c.reset}`);
  print(`  ${c.cyan}pm2 startup${c.reset}  ${c.dim}${t("(它会打印一条 sudo 命令，复制跑一下)", "(prints a sudo command — copy and run)")}${c.reset}`);
  print(`  ${c.cyan}pm2 save${c.reset}`);
  br();

  // tmux 教程
  printTmuxGuide();

  print(t(`祝你玩得愉快 ${c.yellow}🎉${c.reset}`, `Have fun! ${c.yellow}🎉${c.reset}`));
  br();
}

// ============================================================
// 语言选择（step 0）
// ============================================================

async function stepPickLanguage(): Promise<void> {
  print("");
  print(`${c.bold}${c.cyan}  Language / 语言${c.reset}`);
  print("");
  print(`  ${c.yellow}1${c.reset})  中文`);
  print(`  ${c.yellow}2${c.reset})  English`);
  print("");
  while (true) {
    write(`${c.bold}Choose / 选择 [1]${c.reset}: `);
    const answer = (await readLine()).trim() || "1";
    if (answer === "1" || answer.toLowerCase() === "zh" || answer.toLowerCase() === "中文") {
      lang = "zh";
      break;
    }
    if (answer === "2" || answer.toLowerCase() === "en" || answer.toLowerCase() === "english") {
      lang = "en";
      break;
    }
    print(`  ${c.red}✗${c.reset}  Please enter 1 or 2. / 请输入 1 或 2。`);
  }

  // v1.9.31+: 把选的语言写到 ~/.claude-orchestrator/config.json，bridge / launcher /
  // manager 等 daemon 启动时通过 initLang() 读出来做 app-wide i18n
  try {
    const { setLang } = await import("./lib/config-store.js");
    const { setLangInMemory } = await import("./lib/i18n.js");
    await setLang(lang);
    setLangInMemory(lang);
  } catch (e: any) {
    // 非关键：即使写配置失败 setup 本身还是按所选语言继续
    console.error(`warning: failed to persist lang to config: ${e.message}`);
  }
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  print("");
  print(`${c.bold}${c.cyan}   ░█▀▀░█░░░█▀█░█░█░█▀▄░█▀▀░█▀▀░▀█▀░█▀▄░█▀█${c.reset}`);
  print(`${c.bold}${c.cyan}   ░█░░░█░░░█▀█░█░█░█░█░█▀▀░▀▀█░░█░░█▀▄░█▀█${c.reset}`);
  print(`${c.bold}${c.cyan}   ░▀▀▀░▀▀▀░▀░▀░▀▀▀░▀▀░░▀▀▀░▀▀▀░░▀░░▀░▀░▀░▀${c.reset}`);

  // v1.9.30+: 第一件事选语言，后续所有 prompt/hint/error 按选的语言走
  await stepPickLanguage();

  print("");
  print(`   ${c.dim}${t("从手机 Discord 管理本地 Claude Code session", "Manage local Claude Code sessions from Discord on your phone")}${c.reset}`);
  print(`   ${c.dim}${t("接下来 8 个步骤，大概 10 分钟搞定", "8 steps, about 10 minutes total")}${c.reset}`);
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
  fail(t("安装向导出错: ", "Setup wizard error: ") + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
