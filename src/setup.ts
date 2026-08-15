#!/usr/bin/env bun
/**
 * Claudestra 傻瓜式安装向导
 *
 * 用法：bun run setup
 *
 * 这个脚本把所有 Discord 配置步骤都内置了，你不需要读文档。
 * 跟着它走，它会告诉你每一步点哪里、复制什么、粘贴到哪。
 */

import { readFile, writeFile, access, chmod, mkdir } from "fs/promises";
import { constants, readSync, openSync } from "fs";
import { resolve } from "path";
import { printTmuxGuide } from "./lib/tmux-guide.js";
import { resolveBunPath } from "./lib/bun-path.js";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENV_PATH = `${REPO_ROOT}/.env`;
const ENV_EXAMPLE_PATH = `${REPO_ROOT}/.env.example`;
const TEMPLATE_PATH = `${REPO_ROOT}/master/CLAUDE.md.template`;
// v2.16+ MASTER_DIR 可 env 覆盖(移出仓库避免 master 加载仓库根 CLAUDE.md)
const RENDERED_PATH = `${process.env.MASTER_DIR || `${REPO_ROOT}/master`}/CLAUDE.md`;

// v2.10+: 步骤总数随前端选择变化（Discord 5 步可跳过、Web 1 步可加），
// 编号用自增计数器,不再硬编码。
// 0 = 还不知道总数（要等「选择前端」那步定下来）—— 此时只显示 [n]，不显示 [n/8]，
// 否则前两步先报一个猜的分母、选完前端又跳成别的数，看着像出错了。
let TOTAL_STEPS = 0;
let stepNo = 0;
const nextStep = () => ++stepNo;

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
  const counter = TOTAL_STEPS > 0 ? `${step}/${TOTAL_STEPS}` : `${step}`;
  print(`${c.bold}${c.cyan}  [${counter}] ${title}${c.reset}`);
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
  // v2.4.0+ 起 daemon 由 launchd 直管（install-cli 写 plist）,pm2 已不是依赖——
  // 之前留在这里会逼新用户装一个用不上的全局包,缺它还会中断整个安装流程。
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
  header(nextStep(), t("检查系统依赖 + 自动安装", "Check system dependencies + auto-install"));

  const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  if (!platform) {
    fail(t(`不支持的系统: ${process.platform}。Claudestra 只支持 macOS 和 Linux`, `Unsupported OS: ${process.platform}. Claudestra supports macOS and Linux only`));
    process.exit(1);
  }
  if (platform === "linux") {
    // 说在前面，别让用户走完 19 步才发现开机自启没装上。三个 daemon 本身是普通
    // Bun 进程，Linux 上跑得起来；只有进程守护那步是 launchd 专有的。
    warn(t(
      "Linux 上进程守护（开机自启）尚未实现——最后一步 install-cli 会报错并给出 systemd unit 模板，需要你手动接管。其余功能与平台无关。",
      "Autostart/supervision is macOS-only for now: the final install-cli step will fail on Linux and print a systemd user-unit template for you to adapt. Everything else is platform-neutral.",
    ));
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
  header(nextStep(), t("创建 Discord 应用", "Create Discord application"));

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
  header(nextStep(), t("获取 Bot Token", "Get the Bot Token"));

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
  header(nextStep(), t("开启 Privileged Intents", "Enable Privileged Intents"));

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
  header(nextStep(), t("邀请 Bot 到你的服务器", "Invite the bot to your server"));

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
    `跨 Claudestra 协作（v2.11+ HTTP peer）：两台 Claudestra 通过 HTTP API 互访，不需要共享 Discord 服务器。${c.cyan}bun src/manager.ts peer-http-invite <peer> --agents <a,b> --url <你的bridge地址>${c.reset} 发起三步握手（详见 docs/design-http-peers.md）。`,
    `Cross-Claudestra peer collaboration (v2.11+ HTTP peers): two Claudestra installs talk over HTTP API — no shared Discord server needed. Run ${c.cyan}bun src/manager.ts peer-http-invite <peer> --agents <a,b> --url <your bridge url>${c.reset} to start the 3-step handshake (see docs/design-http-peers.md).`,
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
  header(nextStep(), t("开启开发者模式 + 收集 ID", "Enable Developer Mode + collect IDs"));

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
  header(nextStep(), t("个人偏好", "Personal preferences"));

  print(t("最后几个小问题，都有默认值，直接按 ENTER 就行。", "A few small questions. All have defaults — press ENTER to accept."));
  br();

  const userName = await promptRequired(
    `${kbd(t("你的称呼", "Your name"))} ${c.dim}${t("(大总管在回复里怎么叫你)", "(how the master will address you in replies)")}${c.reset}`,
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

/**
 * 收尾结果。`deferred` = 用户选了自己跑（不是失败）；`failures` = 真的没装上的
 * 关键件。这两个都要带回 stepDone —— 此前不论装成什么样都无条件打印「✨ 安装
 * 完成！」，MCP / hooks / launchd 三处失败全是 warn-continue，用户盯着「完成」
 * 而 bot 根本不理他，是最贵的一类支持成本。
 */
interface FinalizeResult { deferred: boolean; failures: string[] }

async function stepFinalize(cfg: Config): Promise<FinalizeResult> {
  header(nextStep(), t("写入配置 + 自动化收尾", "Write config + auto-finalize"));
  const failures: string[] = [];

  // 写 .env
  if (await fileExists(ENV_PATH)) {
    warn(t(".env 已存在", ".env already exists"));
    if (!(await confirm(t("要覆盖吗？", "Overwrite?"), false))) {
      fail(t("已取消。你现有的 .env 没被动", "Cancelled. Existing .env left untouched"));
      process.exit(1);
    }
  }
  await writeFile(ENV_PATH, buildEnvContent(cfg));
  // 0600：里面是 Discord bot token —— 拿到它等于拿到这个 bot 的全部权限。
  // 默认 umask 会写成 0644，同机其他用户可读。
  await chmod(ENV_PATH, 0o600).catch(() => {});
  ok(t(`写入 ${c.bold}.env${c.reset}`, `Wrote ${c.bold}.env${c.reset}`));

  // 渲染 master/CLAUDE.md
  if (await fileExists(TEMPLATE_PATH)) {
    let tpl = await readFile(TEMPLATE_PATH, "utf-8");
    tpl = tpl.replaceAll("{{USER_NAME}}", cfg.USER_NAME).replaceAll("{{REPO_ROOT}}", REPO_ROOT);
    await mkdir(RENDERED_PATH.replace(/\/CLAUDE\.md$/, ""), { recursive: true }).catch(() => {});
    await writeFile(RENDERED_PATH, tpl);
    ok(t(
      `渲染 ${c.bold}master/CLAUDE.md${c.reset}（你的名字: ${c.yellow}${cfg.USER_NAME}${c.reset}）`,
      `Rendered ${c.bold}master/CLAUDE.md${c.reset} (your name: ${c.yellow}${cfg.USER_NAME}${c.reset})`,
    ));
  }

  br();

  // 自动跑依赖安装 + MCP 注册 + 装 launchd daemon
  print(t("下面这些命令我可以直接帮你跑掉，一键启动:", "I can run these commands for you, one-click launch:"));
  print(`  ${c.dim}•${c.reset} ${c.cyan}bun install${c.reset}`);
  print(`  ${c.dim}•${c.reset} ${c.cyan}npx playwright@1.58.2 install chromium${c.reset}  ${c.dim}${t("(终端截图用)", "(for terminal screenshots)")}${c.reset}`);
  print(`  ${c.dim}•${c.reset} ${c.cyan}claude mcp add ${cfg.MCP_NAME} ...${c.reset}  ${c.dim}${t("(注册 MCP server)", "(register MCP server)")}${c.reset}`);
  print(`  ${c.dim}•${c.reset} ${c.cyan}${t("注册 typing hooks", "register typing hooks")}${c.reset}  ${c.dim}${t("(写入 ~/.claude/settings.json)", "(write to ~/.claude/settings.json)")}${c.reset}`);
  print(`  ${c.dim}•${c.reset} ${c.cyan}${t("装 claudestra 命令 + 3 个 launchd daemon", "install claudestra CLI + 3 launchd daemons")}${c.reset}  ${c.dim}${t("(开机自启 + KeepAlive)", "(boot autostart + KeepAlive)")}${c.reset}`);
  br();

  if (!(await confirm(t("要我一键帮你跑完吗？", "Run them all now?"), true))) {
    br();
    ok(t("配置已保存。剩下的命令自己跑：", "Config saved. Run the rest yourself:"));
    print(`  ${c.cyan}cd ${REPO_ROOT}${c.reset}`);
    print(`  ${c.cyan}bun install${c.reset}`);
    print(`  ${c.cyan}npx playwright@1.58.2 install chromium${c.reset}`);
    print(`  ${c.cyan}claude mcp add ${cfg.MCP_NAME} -s user -- bun run ${REPO_ROOT}/src/channel-server.ts${c.reset}`);
    print(`  ${c.dim}# ${t("typing hooks: 手动编辑 ~/.claude/settings.json，或重跑 bun run setup", "typing hooks: edit ~/.claude/settings.json manually, or rerun bun run setup")}${c.reset}`);
    print(`  ${c.cyan}bun src/manager.ts install-cli${c.reset}  ${c.dim}${t("(写 launchd plist + 启 3 个 daemon)", "(write launchd plists + start 3 daemons)")}${c.reset}`);
    return { deferred: true, failures };
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
    return { deferred: false, failures: ["bun install"] };
  }

  // 2. playwright
  write(`${c.dim}▶${c.reset} playwright install chromium… `);
  const pw = await run(["bunx", "playwright@1.58.2", "install", "chromium"], { cwd: REPO_ROOT });
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
    failures.push(t(
      `MCP 注册（没有它 agent 无法回复你）— 手动跑：claude mcp add ${cfg.MCP_NAME} -s user -- bun run ${REPO_ROOT}/src/channel-server.ts`,
      `MCP registration (without it agents cannot reply) — run: claude mcp add ${cfg.MCP_NAME} -s user -- bun run ${REPO_ROOT}/src/channel-server.ts`,
    ));
  }

  // 4. hooks (typing indicator) — 直接写 ~/.claude/settings.json
  //    用 bun 绝对路径。v2.4.0 切到 launchd 后 worker 的 /bin/sh PATH 不带 ~/.bun/bin，
  //    用相对 "bun" 会 "command not found" 让 Stop hook 每次都报错。
  const bunAbs = resolveBunPath();
  const hookCmd = `${bunAbs} ${REPO_ROOT}/src/hooks/typing-hook.ts`;
  write(`${c.dim}▶${c.reset} ${t("注册 typing hooks", "Registering typing hooks")}… `);
  try {
    await registerHooks(hookCmd);
    print(`${c.green}✓${c.reset}`);
  } catch (e: any) {
    print(`${c.yellow}⚠${c.reset}`);
    warn(t(`hook 注册失败: ${e.message}`, `Hook registration failed: ${e.message}`));
    hint(t("typing 指示器可能不会自动停止，需手动编辑 ~/.claude/settings.json", "Typing indicator may not auto-stop. Edit ~/.claude/settings.json manually."));
    failures.push(t(
      "typing hooks（输入指示器不会自动停）— 手动编辑 ~/.claude/settings.json，或重跑 bun run setup",
      "typing hooks (the typing indicator will not auto-stop) — edit ~/.claude/settings.json, or rerun bun run setup",
    ));
  }

  // 5. v2.4.0+: 装 `claudestra` 命令 + 3 个 user-level launchd plist 直管 daemon
  //    （不再依赖 pm2 启动链 —— 之前 pm2 走 env-node 会被 brew 升级 icu4c 等弄废，
  //    现在每个 daemon plist 直接调绝对路径的 bun 跑 .ts，唯一依赖 bun + launchd）。
  //    迁移老 com.claudestra.autostart.plist + 老 pm2.<user>.plist + stop 老 pm2 daemon。
  write(`${c.dim}▶${c.reset} ${t("装 claudestra 命令 + 3 个 launchd daemon", "Install claudestra CLI + 3 launchd daemons")}… `);
  try {
    const { installClaudestraCli } = await import("./lib/cli-install.js");
    const r = await installClaudestraCli(REPO_ROOT);
    if (r.errors.length > 0) {
      print(`${c.red}✗${c.reset}`);
      for (const e of r.errors) warn(e);
      failures.push(t(
        `launchd daemon（bridge / launcher / cron 不会自启）— 手动跑：bun src/manager.ts install-cli\n     ${r.errors.join("; ")}`,
        `launchd daemons (bridge / launcher / cron will not start) — run: bun src/manager.ts install-cli\n     ${r.errors.join("; ")}`,
      ));
    } else {
      print(`${c.green}✓${c.reset}`);
      ok(t(
        `命令装在 ${c.cyan}${r.cliWrapper}${c.reset}（以后直接打 ${c.bold}claudestra${c.reset} 就行）`,
        `Wrote ${c.cyan}${r.cliWrapper}${c.reset} (just type ${c.bold}claudestra${c.reset} from anywhere)`,
      ));
      for (const d of r.daemons) {
        const status = d.loaded ? `${c.green}✓${c.reset} loaded` : `${c.yellow}⚠${c.reset} ${d.warning || ""}`;
        ok(t(`${c.cyan}${d.label}${c.reset}  ${status}`, `${c.cyan}${d.label}${c.reset}  ${status}`));
        // plist 写成了但没 load 上 —— 单条 warn 混在一堆 ✓ 里很容易被划过去
        if (!d.loaded) {
          failures.push(t(
            `daemon ${d.label} 没 load 上：${d.warning || "原因未知"}`,
            `daemon ${d.label} did not load: ${d.warning || "reason unknown"}`,
          ));
        }
      }
      if (r.oldAutostartPlist) {
        hint(t(
          `老 v2.3.x autostart plist 已 unload + 备份 → ${c.cyan}${r.oldAutostartPlist.backed}${c.reset}`,
          `Old v2.3.x autostart plist unloaded + backed up → ${c.cyan}${r.oldAutostartPlist.backed}${c.reset}`,
        ));
      }
      if (r.oldPm2StartupPlist) {
        hint(t(
          `老 pm2 startup plist 已 unload + 备份 → ${c.cyan}${r.oldPm2StartupPlist.backed}${c.reset}`,
          `Old pm2 startup plist unloaded + backed up → ${c.cyan}${r.oldPm2StartupPlist.backed}${c.reset}`,
        ));
      }
      if (r.pm2Stopped.length > 0) {
        hint(t(
          `老 pm2 daemon 已停 (${r.pm2Stopped.join(", ")})，避免跟 launchd 抢`,
          `Stopped old pm2 daemons (${r.pm2Stopped.join(", ")}) to avoid clashing with launchd`,
        ));
      }
      for (const w of r.warnings) warn(w);
    }
  } catch (e) {
    print(`${c.red}✗${c.reset}`);
    warn(t(`装 claudestra CLI 失败: ${(e as Error).message}`, `claudestra CLI install failed: ${(e as Error).message}`));
    hint(t(
      "可以以后单跑：bun src/manager.ts install-cli",
      "Run later: bun src/manager.ts install-cli",
    ));
    failures.push(t(
      `launchd daemon（bridge / launcher / cron 不会自启）— 手动跑：bun src/manager.ts install-cli`,
      `launchd daemons (bridge / launcher / cron will not start) — run: bun src/manager.ts install-cli`,
    ));
  }
  return { deferred: false, failures };
}

// ============================================================
// 前端选择（v2.10+：Discord 成为选项而非必然,可只配 Web）
// ============================================================

interface Frontends { discord: boolean; web: boolean }

async function stepPickFrontends(existing: Partial<Config>): Promise<Frontends> {
  header(nextStep(), t("选择前端", "Pick your frontends"));
  print(t("Claudestra 有两种入口,可以同时启用,也可以只要一个:", "Claudestra has two frontends. Enable either or both:"));
  br();
  print(`  ${c.bold}${c.yellow}1${c.reset}  ${c.bold}Discord${c.reset} — ${t("手机 App / 推送通知 / 按钮交互(需要 Discord 账号 + 建 bot)", "phone app / push notifications / buttons (needs a Discord account + bot)")}`);
  print(`  ${c.bold}${c.yellow}2${c.reset}  ${c.bold}Web${c.reset} — ${t("浏览器 / PWA,本机系统账号(SSH)登录,不依赖任何第三方", "browser / PWA, logs in with your OS account (SSH), no third-party dependency")}`);
  br();
  // 默认:老用户按现有配置推断;全新安装默认 Discord(经典路径)
  const hasWebEnv = await fileExists(`${REPO_ROOT}/web/.env.local`);
  const def = existing.DISCORD_BOT_TOKEN
    ? hasWebEnv ? "1,2" : "1"
    : hasWebEnv ? "2" : "1";
  while (true) {
    const raw = await prompt(
      `${kbd(t("启用哪些?", "Which ones?"))} ${c.dim}${t("(多选,逗号分隔,如 1,2)", "(multi-select, comma-separated, e.g. 1,2)")}${c.reset}`,
      def,
    );
    const picks = new Set(raw.split(/[,，\s]+/).filter(Boolean));
    const fronts = { discord: picks.has("1"), web: picks.has("2") };
    if (!fronts.discord && !fronts.web) {
      fail(t("至少选一个(输入 1、2 或 1,2)", "Pick at least one (enter 1, 2, or 1,2)"));
      continue;
    }
    // 步骤总数定下来:基础 4 步(依赖/前端/偏好/收尾) + Discord 5 步 + Web 1 步
    TOTAL_STEPS = 4 + (fronts.discord ? 5 : 0) + (fronts.web ? 1 : 0);
    if (!fronts.discord) {
      hint(t("跳过 Discord 的 5 个配置步骤(以后想加,重跑 bun run setup 即可)", "Skipping the 5 Discord steps (rerun `bun run setup` anytime to add it later)"));
    }
    return fronts;
  }
}

// ============================================================
// Web 前端配置（v2.10+）
// ============================================================

/** 解析 web/.env.local 现有键值（保留已有 token,不重复签发） */
function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function stepWebSetup(bridgePort: string): Promise<void> {
  header(nextStep(), t("Web 前端配置", "Web frontend setup"));

  const webDir = `${REPO_ROOT}/web`;
  if (!(await fileExists(`${webDir}/package.json`))) {
    warn(t(
      "本仓库不含 web/ 前端(上游版本)。Web 入口需要 fork 版,先跳过。",
      "This checkout has no web/ frontend (upstream build). Skipping.",
    ));
    return;
  }

  // 1) web/.env.local:保留现有值,缺什么补什么
  const envPath = `${webDir}/.env.local`;
  const cur = (await fileExists(envPath)) ? parseDotEnv(await readFile(envPath, "utf-8")) : {};

  if (!cur.INTERNAL_API_KEY) {
    cur.INTERNAL_API_KEY = [...crypto.getRandomValues(new Uint8Array(24))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    ok(t("生成 INTERNAL_API_KEY(BFF 内部调用凭证)", "Generated INTERNAL_API_KEY (BFF internal credential)"));
  }
  cur.BRIDGE_HTTP_URL = `http://127.0.0.1:${bridgePort}`;

  if (!cur.CLAUDESTRA_API_TOKEN) {
    // 签发 web-ui token(scope: 全部 agent + master + 远程终端)——写 principals.json,
    // 不需要 bridge 在跑
    write(`${c.dim}▶${c.reset} ${t("签发 web-ui API token", "Issuing web-ui API token")}… `);
    const r = await run([
      "bun", `${REPO_ROOT}/src/manager.ts`, "token-add", "web-ui",
      "--agents", "*,master", "--force", "--terminal",
    ], { cwd: REPO_ROOT });
    let secret = "";
    try { secret = JSON.parse(r.out)?.secret || ""; } catch { /* 输出非 JSON */ }
    if (r.ok && secret) {
      cur.CLAUDESTRA_API_TOKEN = secret;
      print(`${c.green}✓${c.reset}`);
    } else {
      print(`${c.red}✗${c.reset}`);
      warn(t(
        "token 签发失败。稍后手动跑: bun src/manager.ts token-add web-ui --agents '*,master' --force --terminal,把 secret 填进 web/.env.local 的 CLAUDESTRA_API_TOKEN",
        "Token issue failed. Run later: bun src/manager.ts token-add web-ui --agents '*,master' --force --terminal, then put the secret into CLAUDESTRA_API_TOKEN in web/.env.local",
      ));
    }
  } else {
    ok(t("已有 CLAUDESTRA_API_TOKEN,不重复签发", "CLAUDESTRA_API_TOKEN already present — not re-issuing"));
  }

  const lines = Object.entries(cur).map(([k, v]) => `${k}=${v}`);
  await writeFile(envPath, "# Claudestra web 前端配置 (由 bun run setup 生成)\n" + lines.join("\n") + "\n");
  // 0600：里面是全权（*,master,--terminal）的 Bridge API token。
  await chmod(envPath, 0o600).catch(() => {});
  ok(t(`写入 ${c.bold}web/.env.local${c.reset}`, `Wrote ${c.bold}web/.env.local${c.reset}`));

  // 2) npm 依赖(web 是独立的 Node/npm 依赖树,与根的 bun 互不干扰)
  if (!(await which("npm"))) {
    warn(t(
      "找不到 npm(web 前端用 Node 运行)。装好 Node 后跑: cd web && npm install",
      "npm not found (the web frontend runs on Node). After installing Node: cd web && npm install",
    ));
    return;
  }
  if (await confirm(t("现在安装 web 依赖吗?(npm install,可能要几分钟)", "Install web dependencies now? (npm install, may take a few minutes)"), true)) {
    write(`${c.dim}▶${c.reset} npm install… `);
    const ni = await run(["npm", "install"], { cwd: webDir });
    if (ni.ok) print(`${c.green}✓${c.reset}`);
    else {
      print(`${c.red}✗${c.reset}`);
      warn(t("npm install 失败,稍后在 web/ 目录手动重试", "npm install failed — retry manually in web/"));
    }
  } else {
    hint(t("稍后自己跑: cd web && npm install", "Run later: cd web && npm install"));
  }
}

// ============================================================
// 完成
// ============================================================

function stepDone(cfg: Config, fronts: Frontends, fin: FinalizeResult): void {
  br();
  // 装没装成，横幅就得说实话 —— 否则用户盯着「✨ 安装完成」而 bot 根本不理他。
  if (fin.failures.length > 0) {
    print(`${c.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    print(`${c.bold}${c.yellow}  ⚠ ${t("配置已写入，但有组件没装上", "Config written, but some components did not install")}${c.reset}`);
    print(`${c.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    br();
    print(`${c.bold}${t("下面这些需要你处理，否则系统跑不起来：", "These need your attention, or the system will not come up:")}${c.reset}`);
    for (const f of fin.failures) print(`  ${c.yellow}•${c.reset} ${f}`);
    br();
    print(t(
      `处理完可以重跑 ${c.cyan}bun run setup${c.reset}，或用 ${c.cyan}bun src/manager.ts doctor${c.reset} 复查。`,
      `Fix them, then rerun ${c.cyan}bun run setup${c.reset}, or check with ${c.cyan}bun src/manager.ts doctor${c.reset}.`,
    ));
    br();
  } else if (fin.deferred) {
    print(`${c.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    print(`${c.bold}${c.cyan}  ${t("配置已写入 — 剩下的命令等你自己跑", "Config written — the remaining commands are yours to run")}${c.reset}`);
    print(`${c.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    br();
  } else {
    print(`${c.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    print(`${c.bold}${c.green}  ✨ ${t("安装完成！", "Installation complete!")}${c.reset}`);
    print(`${c.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    br();
  }
  if (fronts.discord) {
    print(`${c.bold}${t("试一下(Discord):", "Try it (Discord):")}${c.reset}`);
    print(`  ${c.dim}①${c.reset} ${t("打开 Discord，去你的", "Open Discord and go to your")} ${c.yellow}${t("#控制频道", "#control channel")}${c.reset}`);
    print(`  ${c.dim}②${c.reset} ${t(`发一句话给 bot（${c.dim}比如 "你好"${c.reset}）`, `Send the bot a message (${c.dim}e.g. "hi"${c.reset})`)}`);
    print(`  ${c.dim}③${c.reset} ${t(`几秒内 ${c.yellow}${cfg.USER_NAME}${c.reset} 就会回你 + 给你一个按钮菜单`, `Within seconds ${c.yellow}${cfg.USER_NAME}${c.reset} will reply with a button menu`)}`);
    br();
  }
  if (fronts.web) {
    print(`${c.bold}${t("试一下(Web):", "Try it (Web):")}${c.reset}`);
    print(`  ${c.dim}①${c.reset} ${t("启动:", "Start it:")} ${c.cyan}cd web && npm run dev${c.reset}  ${c.dim}${t("(生产部署见 web/CLAUDE.md)", "(production deploy: see web/CLAUDE.md)")}${c.reset}`);
    print(`  ${c.dim}②${c.reset} ${t("浏览器打开", "Open in browser:")} ${url("http://localhost:33333")}`);
    print(`  ${c.dim}③${c.reset} ${t("用本机系统账号(SSH 用户名密码)登录,手机上可「添加到主屏幕」装成 PWA", "Log in with your OS account (SSH username/password). On phones, Add to Home Screen for the PWA")}`);
    br();
  }
  print(`${c.bold}${t("如果没反应:", "If nothing happens:")}${c.reset}`);
  print(`  ${c.cyan}tail -f ~/.claude-orchestrator/logs/bridge.out${c.reset}  ${c.dim}${t("(bridge 日志,launchd 直管)", "(bridge logs, managed by launchd)")}${c.reset}`);
  print(`  ${c.cyan}launchctl list | grep claudestra${c.reset} ${c.dim}${t("(三个 daemon 的存活状态)", "(daemon liveness)")}${c.reset}`);
  br();
  print(`${c.bold}${t("以后随时把整套拉起来 + 进 master TUI:", "Bring everything up + attach to master TUI anytime:")}${c.reset}`);
  print(`  ${c.cyan}claudestra${c.reset}  ${c.dim}${t("(daemon 由 launchd 拉起 + 在 iTerm 里 tmux attach；机器重启后服务自动回来)", "(launchd brings the daemons up + tmux-attaches in iTerm; services auto-restart on boot)")}${c.reset}`);
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
  print(`   ${c.dim}${t("从手机(Discord / Web)管理本地 Claude Code session", "Manage local Claude Code sessions from your phone (Discord / Web)")}${c.reset}`);
  print(`   ${c.dim}${t("跟着向导走,大概 10 分钟搞定", "Follow the wizard — about 10 minutes total")}${c.reset}`);
  print("");

  // 读现有 .env 作为默认值
  let existing: Partial<Config> = {};
  if (await fileExists(ENV_PATH)) {
    existing = parseEnv(await readFile(ENV_PATH, "utf-8"));
  } else if (await fileExists(ENV_EXAMPLE_PATH)) {
    existing = parseEnv(await readFile(ENV_EXAMPLE_PATH, "utf-8"));
  }

  await stepCheckDeps();
  const fronts = await stepPickFrontends(existing);

  // Discord 未选时留空 → bridge 按 WEB_ONLY 模式启动(config.ts:
  // WEB_ONLY = !DISCORD_BOT_TOKEN);控制频道用 web-only 约定的本地常量。
  let token = "";
  let guildId = "";
  let userId = "";
  let controlChannelId = "local-master-control";
  if (fronts.discord) {
    const appId = await stepCreateApp();
    token = await stepGetToken(appId);
    await stepIntents(appId);
    await stepInviteBot(appId);
    ({ guildId, userId, controlChannelId } = await stepCollectIds());
  }
  const { userName, mcpName, bridgePort } = await stepPreferences(existing);
  if (fronts.web) await stepWebSetup(bridgePort);

  const cfg: Config = {
    DISCORD_BOT_TOKEN: token,
    DISCORD_GUILD_ID: guildId,
    ALLOWED_USER_IDS: userId,
    CONTROL_CHANNEL_ID: controlChannelId,
    BRIDGE_PORT: bridgePort,
    USER_NAME: userName,
    MCP_NAME: mcpName,
  };

  const fin = await stepFinalize(cfg);
  stepDone(cfg, fronts, fin);

  process.exit(0);
}

main().catch((err) => {
  print("");
  fail(t("安装向导出错: ", "Setup wizard error: ") + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
