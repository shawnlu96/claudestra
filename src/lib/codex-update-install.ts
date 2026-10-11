/**
 * Codex 升级绑定**实际解析到的那份** npm 安装（lib/codex-auto-update-gate.ts 的 prepareCodexUpdate 用）：
 * - 命令：用安装前缀自己的 npm（<prefix>/bin/npm），没有才退到 canonical 解析的 npm（lib/npm-path.ts），并一律 `--prefix` 钉死前缀——
 *   登录 shell 的 PATH 上排在前面的另一个 npm（另一个 nvm 版本 / homebrew）装进的是别处，shell exit 0 了实际的 codex 却没动；
 * - 复核：命令成功后重探实际解析到的 codex，全局包根目录和前缀都没变、版本就是目标才算升级成功，否则抛 CodexInstallMismatch，
 *   调用方不重启、不报「已更新」；
 * - npm 输出外发前脱敏（redactShellTail）：路径、URL 里的账号密码、token 一律换成占位。
 * 错误文案不带路径（会进 #control 通知 / 网页）。tests/codex-update-audit-install*.test.ts。
 */
import { existsSync } from "node:fs";
import { shellEscape } from "./claude-launch.js";
import { resolveNpm } from "./npm-path.js";

/**
 * probeCodexInstall 的结果：path = 实际解析到的 codex（npm 安装时在包目录里）；可识别的全局安装才有 root（全局包根目录）
 * 和 prefix（它所在的 npm 全局前缀）
 */
export type CodexInstall = { version?: string; npm: boolean; path?: string; prefix?: string; root?: string };
export type TrustedNpm = { npm: string; binDir: string };

/**
 * 安装后复核没过：实际生效的 codex 不是目标版本 / 换了安装位置 / 探不出来。文案以「Codex 升级没生效」开头并点明不是适配器的事：
 * 网页消费者（bridge/runtime-update.ts）把 afterShell 的异常原样拼进错误里，用户得一眼看出该修的是安装而不是 acp-install
 */
export class CodexInstallMismatch extends Error {
  constructor(why: string) {
    super(`Codex 升级没生效（${why}；不是适配器问题，不用跑 acp-install）`);
    this.name = "CodexInstallMismatch";
  }
}

/** 这个前缀可信的 npm：前缀自带的优先（nvm / 官方 node 安装都是这样），否则 canonical 解析的那个（随后 --prefix 钉回这个前缀） */
export function trustedNpmFor(prefix: string, exists: (p: string) => boolean = existsSync, fallback: () => TrustedNpm | null = resolveNpm): TrustedNpm | null {
  const own = `${prefix}/bin/npm`;
  return exists(own) ? { npm: own, binDir: `${prefix}/bin` } : fallback();
}

/**
 * 升级命令。没有 prefix 的安装身份（注入的旧形状）照旧给裸 `npm install -g`；真实探测的 npm 安装一定带 prefix。
 * display 是不含路径的展示文案，失败通知用它。
 */
export function codexInstallCommand(inst: CodexInstall, version: string, npmFor: (prefix: string) => TrustedNpm | null = trustedNpmFor):
  { command: string; display: string } | { error: string } {
  const display = `npm install -g @openai/codex@${version}`;
  if (!inst.prefix) return { command: display, display };
  const npm = npmFor(inst.prefix);
  if (!npm) return { error: "找不到可信的 npm 来更新这份 Codex 安装" };
  // PATH 先放这个 npm 的 bin：npm 的 shebang 是 `env node`，要用和它配套的 node
  const command = `PATH=${shellEscape(npm.binDir)}:"$PATH" ${shellEscape(npm.npm)} install -g --prefix ${shellEscape(inst.prefix)} @openai/codex@${version}`;
  return { command, display };
}

/**
 * 命令成功后调：重探实际解析到的 codex，核安装身份（npm、前缀、全局包根目录）与目标版本；不对就抛 CodexInstallMismatch。
 * 安装前带 root 的，安装后必须是同一个 root：转到同前缀下的本地包 / 未知安装（没有 root）都算换了位置
 */
export async function verifyCodexInstall(before: CodexInstall, version: string, probe: () => Promise<CodexInstall | null>): Promise<void> {
  let now: CodexInstall | null;
  try { now = await probe(); } catch (e) {
    console.warn("⚠️ [codex-update] 安装后重探 codex 失败:", e);
    throw new CodexInstallMismatch("安装命令成功了，但之后探 codex 出错，按没升级处理");
  }
  if (!now) throw new CodexInstallMismatch("安装命令成功了，但之后探不出实际在用的 codex，按没升级处理");
  const moved = !now.npm || now.prefix !== before.prefix || (before.root !== undefined && now.root !== before.root);
  if (moved) throw new CodexInstallMismatch("安装命令成功了，但实际解析到的 codex 换了安装位置，按没升级处理");
  if (now.version !== version) throw new CodexInstallMismatch(`安装命令成功了，但实际在用的 codex 仍是 ${now.version ?? "读不出版本"}，不是 ${version}`);
}

/**
 * shell 输出外发（#control 通知）前脱敏：绝对路径 / ~ 路径 → <路径>，URL 里的 user:pass@ → <凭据>@，
 * _authToken / _auth / _password / token 之类的赋值和 npm_ 开头的令牌 → <已隐藏>。URL 本身（https://registry...）保留，方便看是哪个源
 */
export function redactShellTail(tail: string): string {
  return tail
    .replace(/\/\/[^\s/@]+@/g, "//<凭据>@")
    .replace(/((?:_authToken|_auth|_password|password|token)\s*[=:]\s*)\S+/gi, "$1<已隐藏>")
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, "<已隐藏>")
    .replace(/(^|[\s'"(=,])~?\/[^\s'"(),]+/g, "$1<路径>");
}
