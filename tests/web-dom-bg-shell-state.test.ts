/**
 * bg-shell-state-FIX 全链路：真实输出文件 → bridge bg-activity-watcher（可控时钟）→ event-bus → stream-shape.translate →
 * stream.processStreamEvent → 真 ChatStore → 真 BgTaskButton / BgTaskList（happy-dom）。
 * 流程：start → 静默（前端 15s 轮询的 sweep + 重连快照 replay）3/4/12 分钟 → 继续输出 → 真实 [exited with code N]。
 * 旧红：main 上第 4 分钟 sweep 把 shell 标 done，顶栏徽标掉成弱化、面板出 ✓；快照缺失也直接 ✓。
 * 隔离：HOME / tasks 目录是临时目录；fetch 拦成 404，不出网；happy-dom 只在本文件注册（guard TESTS_WEB_DOM）。
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { activeBgTasksFor, pollBgActivitiesForTest } from "../src/bridge/bg-activity-watcher";
import { subscribeEvents } from "../src/bridge/event-bus";
import { projectJsonlPath } from "../src/lib/jsonl-cost";
import type { BgTaskView } from "../web/features/chat/type";
import type { WebStreamEvent } from "../web/lib/chat/events";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
interface El { textContent: string | null; querySelectorAll(s: string): ArrayLike<El & { getAttribute(n: string): string | null }>; remove(): void; appendChild(c: El): void }
interface Doc { createElement(tag: string): El; body: El }
interface Store {
  state: { bgTasks: BgTaskView[] };
  sweepStaleBgTasks(): void;
}
type Sink = Parameters<typeof import("../web/features/chat/stream").processStreamEvent>[0];

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const mod = (p: string) => new URL(`../web/${p}`, import.meta.url).href;
const MIN = 60_000;
const T0 = Date.parse("2026-10-04T10:00:00Z");
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let ui: {
  ChatStoreProvider: unknown; useChatStoreApi: () => Store; BgTaskList: unknown; BgTaskButton: unknown;
  setLang: (l: "zh" | "en") => void; translate: (e: unknown, l: "zh", s: ReadonlySet<string>) => WebStreamEvent | null;
  bgReplayEvents: (t: unknown[]) => WebStreamEvent[]; processStreamEvent: (s: Sink, e: WebStreamEvent) => void;
};
let root = "", oldHome: string | undefined, clock = T0, store: Store | null = null;
const realFetch = globalThis.fetch;
let unsub = () => {};

const AGENT = { name: "shellchain", channelId: "local-shellchain", cwd: "", sessionId: "sess-chain" };
let tasks = "", jsonl = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bg-shell-dom-"));
  oldHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  AGENT.cwd = join(root, "proj");
  tasks = join(root, "tasks");
  mkdirSync(tasks, { recursive: true });
  jsonl = projectJsonlPath(AGENT.cwd, AGENT.sessionId);
  mkdirSync(join(jsonl, ".."), { recursive: true });
  writeFileSync(jsonl, "");
  setSystemTime(new Date(clock));
  GlobalRegistrator.register({ url: "http://localhost/", width: 1200, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false }), { status: 404 })) as unknown as typeof fetch;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  const cs = await import(mod("features/chat/chat-store.ts"));
  const panel = await import(mod("features/chat/components/bg-task-panel.tsx"));
  const btn = await import(mod("features/chat/components/bg-task-button.tsx"));
  const i18n = await import(mod("lib/i18n.tsx"));
  const shape = await import(mod("lib/chat/stream-shape.ts"));
  const stream = await import(mod("features/chat/stream.ts"));
  ui = { ChatStoreProvider: cs.ChatStoreProvider, useChatStoreApi: cs.useChatStoreApi, BgTaskList: panel.BgTaskList, BgTaskButton: btn.BgTaskButton,
    setLang: i18n.setLang, translate: shape.translate, bgReplayEvents: shape.bgReplayEvents, processStreamEvent: stream.processStreamEvent };
  // bridge 事件 → web 流事件 → ChatStore（与 SSE 消费同一对函数）
  unsub = subscribeEvents({ agent: AGENT.name }, (e) => {
    const w = ui.translate(e, "zh", new Set());
    if (w && store) ui.processStreamEvent(store as unknown as Sink, w);
  });
});

afterAll(async () => {
  unsub();
  globalThis.fetch = realFetch;
  ui?.setLang("zh");
  setSystemTime();
  process.env.HOME = oldHome;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
  rmSync(root, { recursive: true, force: true });
});

const h = () => React.createElement as (...a: unknown[]) => unknown;
/** 挂一份 Provider + 顶栏按钮 + 面板；Probe 把 Provider 里那个真 ChatStore 交出来（首次挂载时） */
async function mount(): Promise<El & { unmount(): Promise<void> }> {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const r = createRoot(host as never);
  function Probe() {
    store = ui.useChatStoreApi();
    return null;
  }
  await React.act(async () => r.render(h()(ui.ChatStoreProvider, null, h()(Probe), h()(ui.BgTaskButton), h()(ui.BgTaskList)) as never));
  return Object.assign(host, { unmount: async () => { await React.act(async () => r.unmount()); host.remove(); } });
}

const poll = async (advance = 0) => {
  clock += advance;
  setSystemTime(new Date(clock));
  await React.act(async () => {
    await pollBgActivitiesForTest({ now: () => clock, agents: async () => [AGENT], shellDir: () => tasks });
  });
};
/** 前端 15s 轮询便车的 sweep + 重连时 BFF 下发的活跃快照（bgReplayEvents 同一份函数） */
const frontendSweepAndReplay = async () => {
  await React.act(async () => {
    store!.sweepStaleBgTasks();
    for (const e of ui.bgReplayEvents(activeBgTasksFor(AGENT.name))) ui.processStreamEvent(store as unknown as Sink, e);
  });
};
const confirmBg = (id: string) => {
  const result = { type: "tool_result", content: `Command running in background with ID: ${id}` };
  appendFileSync(jsonl, JSON.stringify({ type: "user", message: { content: [result] } }) + "\n");
};
const out = (id: string) => join(tasks, `${id}.output`);
const task = (id: string) => store!.state.bgTasks.find((t) => t.id === id)!;
const btnLabel = (host: El) => Array.from(host.querySelectorAll("button[aria-expanded]"))[0]?.getAttribute("aria-label") ?? "";
const badgeCount = (host: El) => Array.from(host.querySelectorAll("button[aria-expanded] span"))[0]?.textContent ?? "";
/** 已结束的卡默认折叠成一行：点开它 */
const doneRow = (host: El) => Array.from(host.querySelectorAll("button")).find((b) => /个已|ended|completed/.test(b.textContent ?? ""));
const expandDone = (host: El) => React.act(async () => (doneRow(host) as unknown as { click(): void }).click());
const rowText = (host: El, title: string) => Array.from(host.querySelectorAll("summary")).find((s) => (s.textContent ?? "").includes(title))?.textContent ?? "";

describe("后台 shell 全链路：静默不等于结束", () => {
  test("复现：start → 静默 3/4/12 分钟（sweep + 快照）仍运行 → 继续输出 → 真实 exit 1 才结束且不显示成功", async () => {
    let host = await mount();
    await poll(); // baseline
    writeFileSync(out("chain1"), "$ bun test > /tmp/run.log 2>&1\n");
    confirmBg("chain1");
    await poll(10_000);
    expect(task("chain1")).toMatchObject({ kind: "shell", status: "running" });
    expect(badgeCount(host)).toBe("1");

    for (const at of [3, 4, 12]) {
      while (clock < T0 + at * MIN + 20_000) {
        await poll(10_000);
        await React.act(async () => store!.sweepStaleBgTasks()); // 每轮 15s 轮询便车的 sweep：不能把静默 shell 收成完成
        expect(task("chain1").status).toBe("running");
      }
      await frontendSweepAndReplay(); // 断线重连：快照 replay
      expect(task("chain1").status).toBe("running");
      expect(task("chain1").shellEnd).toBeUndefined();
      expect(badgeCount(host)).toBe("1");
      expect(btnLabel(host)).toContain("运行中 1");
    }
    // 刷新页面：新 Provider = 新 ChatStore，靠连流快照 replay 重建；面板说已多久无输出、可能仍在运行，绝不说结束 / 成功
    await host.unmount();
    host = await mount();
    await frontendSweepAndReplay();
    expect(task("chain1").status).toBe("running");
    expect(rowText(host, "chain1")).toContain("无输出 12m · 可能仍在运行");
    expect(rowText(host, "chain1")).not.toContain("✓");
    expect(host.querySelectorAll("summary .loading").length).toBe(1);

    appendFileSync(out("chain1"), "still testing…\n");
    await poll(10_000);
    await frontendSweepAndReplay();
    expect(task("chain1").status).toBe("running");

    appendFileSync(out("chain1"), "1 fail\n[exited with code 1]\n");
    await poll(10_000);
    expect(task("chain1")).toMatchObject({ status: "done", shellEnd: { kind: "exited", code: 1 } });
    expect(doneRow(host)?.textContent).toContain("1 个已结束"); // 折叠行：失败不算「已完成」、不画绿勾
    expect(doneRow(host)?.textContent).not.toContain("✓");
    await expandDone(host);
    expect(rowText(host, "chain1")).toContain("✗ exit 1");
    expect(rowText(host, "chain1")).not.toContain("✓");
    expect(badgeCount(host)).toBe("");
    // 结束后的 sweep / 快照不改写已确认的结局
    await frontendSweepAndReplay();
    expect(task("chain1").shellEnd).toEqual({ kind: "exited", code: 1 });
    await host.unmount();
  });

  test("exit 0 = 成功；快照缺失 = 状态未知（不画绿勾，折叠行不说已完成）；再有输出回到运行；中英文", async () => {
    const host = await mount();
    writeFileSync(out("ok0"), "build\n");
    writeFileSync(out("lost"), "serving on :0\n");
    confirmBg("ok0");
    confirmBg("lost");
    await poll(10_000);
    appendFileSync(out("ok0"), "[exited with code 0]\n");
    await poll(10_000);
    expect(task("ok0").shellEnd).toEqual({ kind: "exited", code: 0 });

    // bridge 重启：快照里没有 lost → 状态未知
    await React.act(async () => ui.processStreamEvent(store as unknown as Sink, { t: "bg-sync", ids: [] }));
    expect(task("lost")).toMatchObject({ status: "done", shellEnd: { kind: "unknown" } });
    expect(doneRow(host)?.textContent).toContain("2 个已结束");
    expect(doneRow(host)?.textContent).not.toContain("✓");
    await expandDone(host);
    expect(rowText(host, "ok0")).toContain("✓ exit 0");
    expect(rowText(host, "lost")).toContain("状态未知");
    expect(rowText(host, "lost")).not.toContain("✓");

    await React.act(async () => ui.setLang("en"));
    expect(rowText(host, "lost")).toContain("status unknown");
    expect(rowText(host, "ok0")).toContain("✓ exit 0");
    await React.act(async () => ui.setLang("zh"));

    // 仍被跟踪的那张又来了输出 → 回到运行中（不是永久判死）
    appendFileSync(out("lost"), "GET / 200\n");
    await poll(10_000);
    await React.act(async () => new Promise((r) => setTimeout(r, 2_700))); // bridge 子区推送 debounce
    expect(task("lost")).toMatchObject({ status: "running" });
    expect(task("lost").shellEnd).toBeUndefined();

    // 输出文件被清理：bridge 报 unknown，前端也是状态未知
    unlinkSync(out("lost"));
    await poll(10_000);
    expect(task("lost").shellEnd).toEqual({ kind: "unknown" });
    await host.unmount();
  });

  test("英文：静默提示", async () => {
    writeFileSync(out("en1"), "x\n");
    confirmBg("en1");
    await poll(10_000);
    await poll(5 * MIN);
    await React.act(async () => ui.setLang("en"));
    const host = await mount(); // 新 Provider = 新 store：用快照 replay 重建（刷新页面的路径）
    await frontendSweepAndReplay();
    expect(rowText(host, "en1")).toContain("no output 5m · may still be running");
    expect(btnLabel(host)).toContain("1");
    await React.act(async () => ui.setLang("zh"));
    await host.unmount();
  });

  test("subagent 保持原规则：31 分钟无事件兜底收为完成，快照缺失也直接完成", async () => {
    const host = await mount();
    await React.act(async () => {
      ui.processStreamEvent(store as unknown as Sink, { t: "bg-start", id: "agent-a1", kind: "subagent", title: "🤖 review" });
      ui.processStreamEvent(store as unknown as Sink, { t: "bg-start", id: "agent-a2", kind: "subagent", title: "🤖 lint" });
    });
    setSystemTime(new Date(clock + 31 * MIN + 1000));
    await React.act(async () => store!.sweepStaleBgTasks());
    expect(task("agent-a1").status).toBe("done");
    setSystemTime(new Date(clock));
    await React.act(async () => {
      ui.processStreamEvent(store as unknown as Sink, { t: "bg-start", id: "agent-a2", kind: "subagent", title: "🤖 lint" });
      ui.processStreamEvent(store as unknown as Sink, { t: "bg-sync", ids: [] });
    });
    expect(task("agent-a2").status).toBe("done");
    expect(task("agent-a2").shellEnd).toBeUndefined();
    await host.unmount();
  });
});
