/**
 * QUOTA1 截图的合成数据与入口（tests/web-quota-notice-browser.test.ts 用；改前改后同一份数据、同一个外壳）。照规格「对照基准」：
 * 时刻 2026-10-14 12:00（Asia/Shanghai），重置时刻都在它之后；标题全部合成。
 * 状态：1 Claude 82% 到提醒线、Codex 18%；2 Claude 周额度用完（排队 3 条、2 次重置可用）+ Codex 95% 不再接新活（3 恢复中 / 4 都正常走模型与 DOM 单测，不截图）。
 * 页面：notice = 聊天页外壳（56px 顶栏 + 顶部插槽 + 消息 + 输入框），改前挂旧的两条横幅、改后挂额度卡；links = 侧栏低优先级徽章三行 + 用量看板顶部（真 QuotaArea）。
 * 今天页「团队与额度」块用 TODAY1 的 today-shots 入口（bundleToday / serveToday），这里只给它的 extra 接口。
 * 纯数据 + Response 构造，不 import web 里带 React 的模块。
 */
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { TODAY_NOW } from "./today-shots";

export const QUOTA_NOW = TODAY_NOW;
const H = 3600_000;
const WEEK_RESET = QUOTA_NOW + 2 * 24 * H + 9 * H; // 10/16 21:00
const WALL_RESET = QUOTA_NOW + 3 * H; // 10/14 15:00

const line = (family: string, pct: number, state: string) => ({ family, warnPct: 80, stopPct: 90, weekUsedPct: pct, resetAt: WEEK_RESET, observedAt: QUOTA_NOW - 60_000,
  source: "live", freshness: "fresh", state, mode: "on", limit: state === "stop" ? "zero" : state === "warn" ? "half" : "none", wouldLimit: "none",
  granted: 2, lineCap: 2, available: state === "stop" ? 0 : 2, slots: state === "stop" ? 0 : state === "warn" ? 1 : 2 });
const lines = (claude: [number, string], codex: [number, string]) =>
  ({ ok: true, config: { status: "ok", error: null, mode: "on" }, at: QUOTA_NOW, families: [line("claude", ...claude), line("codex", ...codex)] });

const QUOTA_STATES = {
  s1: { lines: lines([82, "warn"], [18, "below"]), wall: { active: false, queued: 0, wall: null } },
  s2: { lines: lines([100, "stop"], [95, "stop"]),
    wall: { active: true, queued: 3, credits: 2, wall: { kind: "weekly", resetsAt: WALL_RESET, enteredAt: QUOTA_NOW - H, agents: ["agent-a-dev1"] } } },
} as const;
export type QuotaState = keyof typeof QUOTA_STATES;

/** 用量看板的订阅额度快照（GET /quota）：Claude / Codex 各一张卡 */
const SUBSCRIPTION = { enabled: true, snapshot: { generatedAt: QUOTA_NOW, providers: [
  { id: "claude", name: "Claude", kind: "subscription", plan: "Max", account: { identity: "bound" }, source: { layer: "live", observedAt: QUOTA_NOW - 60_000 },
    meters: [{ id: "session", kind: "session", unit: "pct", used: 100, resetsAtMs: WALL_RESET }, { id: "weekly", kind: "weekly", unit: "pct", used: 100, resetsAtMs: WEEK_RESET }] },
  { id: "codex", name: "Codex", kind: "subscription", plan: "Pro", account: { identity: "bound" }, source: { layer: "live", observedAt: QUOTA_NOW - 60_000 },
    meters: [{ id: "weekly", kind: "weekly", unit: "pct", used: 95, resetsAtMs: WEEK_RESET }] },
] } };

/** 额度相关接口（路径不带 /api/v1）；其余交给 today-shots 的夹具 */
export function quotaRoute(state: QuotaState) {
  return (path: string): Response | null => {
    if (path === "/lend/quota-lines") return Response.json(QUOTA_STATES[state].lines);
    if (path === "/quota/wall") return Response.json(QUOTA_STATES[state].wall);
    if (path === "/quota") return Response.json(SUBSCRIPTION);
    return null;
  };
}

/** 截图入口（仓库外写一个入口，按绝对路径引仓库里的模块）；改前仓库里还没有额度卡时挂旧的两条横幅 */
export async function bundleQuota(repo: string, dir: string, fp: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const entry = resolve(dir, "entry.ts"), from = (f: string) => JSON.stringify(resolve(repo, f));
  const merged = existsSync(resolve(repo, "web/features/quota/quota-notice.tsx"));
  const noticeImports = merged ? `import { QuotaNotice } from ${from("web/features/quota/quota-notice.tsx")};`
    : `import { QuotaWallBanner } from ${from("web/features/quota-wall/quota-wall-banner.tsx")};
import { QuotaWarningBanner } from ${from("web/features/lend/quota-warning-banner.tsx")};`;
  const notices = merged ? "h(QuotaNotice, { embedded: true })" : "h(QuotaWallBanner, { embedded: true }), h(QuotaWarningBanner, { embedded: true })";
  await Bun.write(entry, `import { createElement as h } from ${from("web/node_modules/react/index.js")};
import { createRoot } from ${from("web/node_modules/react-dom/client.js")};
import { machines } from ${from("web/lib/machines.ts")};
import { ChatStoreProvider } from ${from("web/features/chat/chat-store.ts")};
import { ChatNavContext } from ${from("web/features/chat/components/nav-context.tsx")};
import { QuotaWarningSlot } from ${from("web/features/lend/quota-warning-slot.tsx")};
import { LpBadge } from ${from("web/features/fleet/lp-badge.tsx")};
import { QuotaArea } from ${from("web/features/chat/components/subscription-quota-cards.tsx")};
import { useSubscriptionQuota } from ${from("web/features/chat/use-subscription-quota.ts")};
${noticeImports}
document.documentElement.dataset.theme = "light";
await machines.add({ fp: "${fp}", name: "本机" });
await machines.setCurrent("${fp}");
const view = new URLSearchParams(location.search).get("view");
const nav = { showContent: true, toContent: () => {}, toList: () => {} };
const msgs = Array.from({ length: 12 }, (_, i) => h("div", { key: i, className: "rounded-xl bg-base-200 p-3 text-sm" }, "合成消息 " + (i + 1)));
const notice = h("div", { id: "cstra-shell", className: "relative flex h-screen flex-col bg-base-100 text-base-content" },
  h("header", { style: { height: 56 }, className: "flex shrink-0 items-center border-b border-base-300 px-4 text-sm font-semibold" }, "合成会话 · 本机"),
  h(QuotaWarningSlot, null, ${notices}),
  h("main", { className: "min-h-0 flex-1 space-y-2 overflow-auto p-4" }, msgs),
  h("footer", { className: "shrink-0 border-t border-base-300 p-3" }, h("textarea", { className: "textarea textarea-bordered w-full", rows: 2, defaultValue: "" })));
const lp = (over) => ({ lowPriority: "off", walled: false, offer: false, at: 0, ...over });
const ROWS = [["导出开发", lp({ lowPriority: "on", resetsAt: "15:00", allowancePct: 40 })], ["通知开发", lp({ lowPriority: "exhausted" })],
  ["同步开发", lp({ walled: true, resetsAt: "15:00" })]];
function Usage() {
  const quota = useSubscriptionQuota(true);
  return h(QuotaArea, { quota, g: null, quotas: [] });
}
const links = h("div", { className: "min-h-screen space-y-4 bg-base-100 p-4 text-base-content" },
  h("aside", { className: "w-72 max-w-full space-y-1 rounded-xl bg-base-200/60 p-2" }, h("ul", { className: "space-y-1" }, ROWS.map(([name, s]) =>
    h("li", { key: name, className: "flex items-center gap-2 rounded-lg bg-base-100 px-3 py-2 text-sm", "data-lp-row": "" },
      h("span", { className: "min-w-0 flex-1 truncate" }, name), h(LpBadge, { lp: s }))))),
  h("section", { className: "w-full max-w-md rounded-2xl bg-base-100 px-5 pb-5 pt-4 shadow-xl ring-1 ring-base-300", "data-usage-top": "" },
    h("div", { className: "pb-2 text-base font-semibold" }, "用量看板"), h(Usage)));
createRoot(document.getElementById("root")).render(h(ChatStoreProvider, null, h(ChatNavContext.Provider, { value: nav }, view === "links" ? links : notice)));
`);
  const build = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--outdir", resolve(dir, "dist"), "--tsconfig-override", "web/tsconfig.json"],
    { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  return resolve(dir, "dist");
}
