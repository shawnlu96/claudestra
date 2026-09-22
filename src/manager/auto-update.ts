/**
 * 自动更新开关命令（auto-update）。只改 config.json，不执行升级。
 *
 * 从 manager.ts 逐字搬出（函数体未改，只加 export / 改相对路径）。
 */
import { output } from "./core.js";
export async function cmdAutoUpdate(sub: string, ...rest: string[]) {
  const { readConfig, setAutoUpdate, setUpdateChannel } = await import("../lib/config-store.js");

  if (sub === "status" || sub === "" || sub === "get") {
    const cfg = await readConfig();
    const chan = cfg.autoUpdate.channel ?? "release";
    output({
      ok: true,
      autoUpdate: cfg.autoUpdate,
      message: `Claudestra: ${cfg.autoUpdate.claudestra ? "on" : "off"} · Claude Code: ${cfg.autoUpdate.claudeCode ? "on" : "off"} · 通道: ${chan}`,
    });
    return;
  }

  // v2.17 auto-update channel beta|release —— beta 紧跟 origin/main 每个 commit
  if (sub === "channel") {
    const chan = rest[0]?.toLowerCase();
    if (chan !== "beta" && chan !== "release") {
      output({ ok: false, error: "usage: auto-update channel <beta|release>" });
      return;
    }
    const cfg = await setUpdateChannel(chan);
    output({
      ok: true,
      autoUpdate: cfg.autoUpdate,
      message: chan === "beta"
        ? "已切到 beta 通道:update/自动更新将紧跟 origin/main 的每个 commit(未经 release 验证,自担风险)"
        : "已切回 release 通道:只跟正式发布版本",
    });
    return;
  }

  // auto-update claudestra on|off  |  auto-update claude on|off
  const targetAlias: Record<string, "claudestra" | "claudeCode"> = {
    claudestra: "claudestra",
    self: "claudestra",
    claude: "claudeCode",
    "claude-code": "claudeCode",
    claudecode: "claudeCode",
    cc: "claudeCode",
  };
  const target = targetAlias[sub.toLowerCase()];
  const state = rest[0]?.toLowerCase();

  if (!target || (state !== "on" && state !== "off")) {
    output({
      ok: false,
      error: `usage: auto-update <claudestra|claude> <on|off>  |  auto-update status`,
    });
    return;
  }

  const cfg = await setAutoUpdate(target, state === "on");
  output({
    ok: true,
    autoUpdate: cfg.autoUpdate,
    message: `${target} 自动更新已${state === "on" ? "开启" : "关闭"}`,
  });
}
