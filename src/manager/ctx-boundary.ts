/**
 * manager ctx-boundary：上下文边界自动注入的开关和演练（docs/architecture/context-boundary.md）。
 *   dry-run  读线上的 registry、画面、配置和落盘的冷却 / 守卫，分「原有行为（开关管不着）」和「新增（开关打开才生效）」两段
 *            列出会对谁做什么、为什么；一个键都不发、不写任何状态
 *   status   开关现状
 *   on|off   写 config.json 的 autoCompact.inject（bridge 每轮现读，不用重启）；只管具名策略和大总管，全局线和救命线一直在跑
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
  type Outcome = (typeof r.on)[number];
  const result = (o: Outcome) =>
    o.verdict.fire
      ? `会注入（${o.verdict.kind === "hard-cap" ? "过硬上限，忙也发" : "过线且闲置"}）：${o.would}`
      : `不动：${SKIP_REASON_TEXT[o.verdict.reason]}`;
  const row = (o: Outcome) => ({ agent: o.agent, ctx: o.ctx, policy: o.boundary.policy, window: o.boundary.window, hardCap: o.boundary.hardCap, result: result(o) });
  const m = r.master;
  output({
    ok: true,
    inject: r.inject,
    note: `${r.inject ? "开关开着" : "开关关着（ctx-boundary on 打开）"}；两段都只列过线的 agent，没列的都在线下`,
    existing: {
      note: "原有行为，开关管不着：全局自动 save-compact 和 93% 救命线。开关关着时，具名策略覆盖的 agent 也按这条走；大总管不在内",
      agents: r.off.map(row),
    },
    gated: {
      note: "新增，开关打开才生效：具名策略（执行者、协调者…）改按自己的线压，大总管纳入自动压缩",
      agents: r.on.filter((o) => o.gated && o.agent !== m?.agent).map(row),
      // 大总管以前从没被自动压过（target 拼成 master:=agent-master，读不到画面），修好后第一次纳入：单独列出来给 owner 拍板
      master: m
        ? {
            agent: m.agent, ctx: m.ctx, policy: m.boundary.policy, window: m.boundary.window, hardCap: m.boundary.hardCap, action: m.boundary.action,
            result: m.outcome ? result(m.outcome) : "在线下，这一轮不动",
            note: "大总管这次起才纳入自动压缩（走全局路径）；打开开关前请 owner 决定要不要让它自动压",
          }
        : "registry 里没有大总管（agent-master）",
    },
    log: r.logs,
  });
}
