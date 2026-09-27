/**
 * setup 向导里「先说清楚」的几段话：选前端时各自的代价、装机会改到仓库外的哪些地方、bypass 之外还要知道的两件事、
 * 装完用的是哪种访问方式。单独成文件是因为 setup.ts 只许变小；终端原语由 setup.ts 注入（SetupUi）。
 * 改动清单对应 lib/cli-install.ts installCli 的步骤与 setup.ts 的 registerHooks：那边加了全局改动，这里要加一行。
 */
import { homedir } from "node:os";
import { STATE_DIR } from "./paths.js";
import type { SetupUi } from "./setup-remote-access.js";

/** 选前端时的两行：Web 的浏览器↔bridge 这段不经第三方，手机怎么连下一步单独选；Discord 的对话内容会存在 Discord 上 */
export function frontendChoiceLines(t: SetupUi["t"]): { web: string; discord: string } {
  return {
    web: t(
      "浏览器 / 可以装到手机主屏的 PWA，由本机 bridge 直接托管；在这台电脑上开浏览器就能用，浏览器到 bridge 这段不经过第三方（模型调用照常发给各家模型服务）。" +
        "手机怎么连，下一步单独选（中继 / Tailscale / 局域网 / 自己的域名）",
      "browser / installable PWA served by the bridge on this machine; a browser here reaches the bridge with no third party in between " +
        "(model calls still go to the model providers). How your phone reaches it is the next step (relay / Tailscale / LAN / your own domain)",
    ),
    discord: t(
      "在 Discord 里和 agent 对话。要自己建一个 bot（多 5 步），所有对话内容都会经过并保存在 Discord 的服务器上",
      "chat with agents inside Discord. You create your own bot (5 extra steps); all conversation content passes through and is stored on Discord's servers",
    ),
  };
}

/** 装机前的改动清单：只列仓库以外的东西；卸载步骤在 SETUP.md「卸载」 */
export function printMachineChanges(ui: SetupUi, mcpName: string): void {
  const { t, c } = ui;
  const item = (s: string) => ui.print(`  ${c.dim}•${c.reset} ${s}`);
  const sub = (s: string) => ui.print(`      ${c.dim}- ${s}${c.reset}`);
  ui.print(t("会改到这台电脑上仓库以外的这些地方，先说清楚：", "These changes land outside the repo on this machine — listed up front:"));
  item("~/.claude/settings.json");
  sub(t("加 Stop / StopFailure / Notification 三个 hook（不在 Claudestra 会话里时静默退出）", "adds Stop / StopFailure / Notification hooks (they exit silently outside Claudestra sessions)"));
  sub(t("加一个 SessionStart hook：开 Claude Code 会话时注入该项目上次留下的 HANDOFF 交接（没有就什么也不做）",
        "adds a SessionStart hook: new Claude Code sessions get the project's last HANDOFF note injected (nothing if there is none)"));
  sub(t("把已装 MCP 服务的工具加进 permissions.allow（你自己开的 Claude Code 会话也会生效）", "adds your installed MCP servers' tools to permissions.allow (applies to your own Claude Code sessions too)"));
  sub(t("记下你刚才同意的 bypass 模式", "records the bypass-mode consent you just gave"));
  item(t(`Claude Code 用户级 MCP：注册 ${mcpName}`, `Claude Code user-level MCP: registers ${mcpName}`));
  item(t("~/Library/LaunchAgents：bridge / launcher / cron 三个开机自启服务", "~/Library/LaunchAgents: three autostart services (bridge / launcher / cron)"));
  item(t("~/.local/bin/claudestra 命令，外加 ~/.bun/bin/claudestra 软链；登录 shell 找不到它时在 profile（zsh 是 ~/.zprofile）末尾补一行 PATH",
         "the ~/.local/bin/claudestra command plus a ~/.bun/bin/claudestra symlink; if your login shell can't find it, one PATH line is appended to its profile (~/.zprofile for zsh)"));
  item(t("~/.claude/skills：链接仓库自带的技能（目前是 save-clear / save-compact）；同名的目录和指向别处的软链都不动",
         "~/.claude/skills: links the bundled skills (currently save-clear / save-compact); same-name directories and symlinks pointing elsewhere are left alone"));
  item(t("从旧版本升上来时：停掉旧的 pm2 服务、卸掉旧的 LaunchAgent、迁移旧 Web 服务的数据（先备份）；每次安装都会重载三个服务",
         "when upgrading from an older version: stops old pm2 services, unloads old LaunchAgents and migrates the old web service's data (backed up first); every install reloads the three services"));
  item(t("iTerm 偏好 TmuxDashboardLimit（装了 iTerm 才改）", "iTerm preference TmuxDashboardLimit (only if iTerm is installed)"));
  const state = STATE_DIR.replace(homedir(), "~");
  item(t(`Claudestra 自己的状态与会话归档在 ${state}（归档不加密；各 runtime 的原始会话记录仍在它们自己的目录）`,
         `Claudestra's own state and session archive live in ${state} (the archive is not encrypted; each runtime keeps its raw session logs in its own directory)`));
  ui.hint(t("卸载：SETUP.md 的「卸载」一节", "To uninstall: the Uninstalling section of SETUP.md"));
}

/** bypass 同意之外的两件事：配对设备等于 shell 钥匙；Channels 还在研究预览 */
export function printBypassExtras(ui: SetupUi): void {
  const { t } = ui;
  ui.print(t("还有两件事：", "Two more things:"));
  ui.print(t(
    "  ① 按默认全部权限配对的每一台手机或浏览器，都等于这台电脑的一把 shell 钥匙。丢了设备就去网页「设备」面板撤销。",
    "  ① Every phone or browser paired with the default full grant is effectively a shell key to this machine. If one is lost, revoke it in the web client's Devices panel.",
  ));
  ui.print(t(
    "  ② Claudestra 依赖 Claude Code 还在研究预览阶段的 Channels 能力，Claude Code 升级后可能暂时用不了，我们会跟着修。",
    "  ② Claudestra relies on Claude Code's Channels feature, still a research preview; a Claude Code update may break it for a while until we catch up.",
  ));
}

export type AccessKind = "relay" | "tailscale" | "lan" | "custom";

/** 完成横幅里的一行：现在用的是哪种访问方式、怎么换、怎么体检 */
export function printAccessSummary(ui: SetupUi, kind: AccessKind | undefined): void {
  const { t, c } = ui;
  const name: Record<AccessKind, string> = {
    relay: t("中继", "relay"),
    tailscale: "Tailscale",
    lan: t("局域网", "LAN"),
    custom: t("自己的域名", "your own domain"),
  };
  ui.print(`  ${c.dim}${t("手机访问方式", "Phone access")}: ${kind ? name[kind] : t("没配（只能本机用）", "not set up (this machine only)")}${c.reset}`);
  ui.print(`  ${c.dim}${t("换方式：重跑 bun run setup · 体检：claudestra doctor · 卸载：SETUP.md「卸载」", "Switch: rerun `bun run setup` · Health check: `claudestra doctor` · Uninstall: SETUP.md")}${c.reset}`);
}
