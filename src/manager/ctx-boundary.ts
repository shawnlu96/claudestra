/**
 * manager ctx-boundary：上下文边界自动注入的开关和演练（docs/architecture/context-boundary.md）。
 *   dry-run  读线上的 registry、画面、配置和落盘的冷却 / 守卫，列出「会对谁做什么、为什么」；一个键都不发、不写任何状态
 *   status   开关现状
 *   on|off   写 config.json 的 autoCompact.inject（bridge 每轮现读，不用重启）
 */
import { output } from "./core.js";

export async function cmdCtxBoundary(args: string[]): Promise<void> {
  const sub = args[0] ?? "status";
  const { readConfig, setAutoCompact } = await import("../lib/config-store.js");
  if (sub === "on" || sub === "off") {
    await setAutoCompact({ inject: sub === "on" });
    output({ ok: true, inject: sub === "on" });
    return;
  }
  if (sub === "status") {
    output({ ok: true, inject: (await readConfig()).autoCompact?.inject === true });
    return;
  }
  if (sub !== "dry-run") {
    output({ ok: false, error: `未知子命令 ${sub}`, usage: "ctx-boundary dry-run | status | on | off" });
    return;
  }
  const { ctxBoundaryDryRun } = await import("../bridge/ctx-boundary.js");
  const { SKIP_REASON_TEXT } = await import("../lib/ctx-boundary-decision.js");
  const r = await ctxBoundaryDryRun();
  const agents = r.outcomes.map((o) => ({
    agent: o.agent,
    ctx: o.ctx,
    policy: o.boundary.policy,
    window: o.boundary.window,
    hardCap: o.boundary.hardCap,
    result: o.verdict.fire
      ? `会注入（${o.verdict.kind === "hard-cap" ? "过硬上限，忙也发" : "过线且闲置"}）：${o.would}`
      : `不动：${SKIP_REASON_TEXT[o.verdict.reason]}`,
  }));
  output({
    ok: true,
    inject: r.inject,
    note: `${r.inject ? "自动注入开着" : "自动注入关着（ctx-boundary on 打开）"}；只列过线的 agent，没列的都在线下`,
    agents,
    log: r.logs,
  });
}
