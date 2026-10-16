/**
 * NAVBAR1 五个入口的合成数据与回环接口（happy-dom 与截图共用一份），照规格「对照基准」：时刻 2026-10-14 12:00（Asia/Shanghai），标题全部合成，
 * 机器只用「本机」「机器 B / C」。在 TODAY1 夹具（today-shots.ts）上加：
 * - 全权设备（/peers/contacts 200）、2 台伙伴机器 1 台在线；/shells 200（shells: 403 时不给）；
 * - 会话 6 个（另有大总管），2 个有未读；项目 4 个；等 owner 的 asks 2 件；
 * - 1 个团队项目，绑定在本机「合成项目 A」上（本机也有这个项目的分组，两个成员）。
 * 改前改后同一份；夹具之外的接口由调用方 404。
 */
import { createV2ProjectsFixtures } from "../../src/lib/shared-ledger-contract-v2-projects-fixtures";
import { sharedProjectsSnapshot } from "../../src/bridge/local-api/shared-projects-snapshot";
import type { SharedProjectsPorts } from "../../src/bridge/local-api/shared-projects-ports";
import { PROJECTS as TODAY_PROJECTS, TODAY_NOW, todayRoute, todayWorld } from "./today-shots";

export { TODAY_NOW as NAV_NOW };
const H = 3600_000;

export const NAV_PROJECTS = [...TODAY_PROJECTS, { id: "proj-d", name: "合成项目 D", emoji: null, dirs: [] }];
/** 绑定了团队的本机项目，与中心项目名 */
export const TEAM_LOCAL = "proj-a";
export const TEAM_NAME = "合成团队项目";

const f = createV2ProjectsFixtures();
const ME = { personId: f.person.personId, instanceId: "instance-local" };
const IDENTITY = { center: f.identity.centerId, team: f.identity.teamId, person: ME.personId, project: f.identity.projectId,
  localProjectId: TEAM_LOCAL, homeInstanceId: ME.instanceId };

export interface NavOptions {
  /** /peers/contacts 的状态码：200 = 全权设备，403 = 部分 scope */
  contacts?: 200 | 403;
  /** /shells 的状态码：200 给新终端入口，403 不给 */
  shells?: 200 | 403;
  /** false = 本机没有任何团队绑定（/shared-projects/snapshot 403、context 为空） */
  team?: boolean;
}

export function navWorld() {
  const w = todayWorld();
  const row = (name: string, projectId: string, over: object = {}) => ({ name, displayName: name, purpose: "", cwd: "/repo", status: "active", projectId,
    lastActivityTs: TODAY_NOW - 3 * H, busy: false, ...over });
  return {
    ...w,
    agents: [...w.agents, row("d-dev", "proj-d", { label: "合成 D 开发" }), row("c-doc", "proj-c", { label: "合成 C 文档" }),
      { name: "master", displayName: "大总管", status: "active", cwd: "/repo", purpose: "", busy: false }] as object[],
    asks: w.asks.slice(0, 2),
  };
}

/** 2 个会话有未读：键是前端名（不带 agent- 前缀，lib/chat/agents.ts 按 mapped.name 取） */
export const UNREAD = { "b-pm": 3, "d-dev": 1 };

function ports(): SharedProjectsPorts {
  const who = { ...f.person, ...f.requests.list, ...ME, subject: "owner:self" as const };
  return {
    person: async () => who,
    list: async () => [{ ...f.project, name: TEAM_NAME }],
    members: async () => [{ ...f.member, personId: ME.personId, role: "owner" }],
    bindings: () => [{ centerId: IDENTITY.center, teamId: IDENTITY.team, projectId: IDENTITY.project, localProjectId: TEAM_LOCAL }],
  } as Partial<SharedProjectsPorts> as SharedProjectsPorts;
}

const localSnapshot = () => ({ peers: [], projects: NAV_PROJECTS.map((p) => ({ id: p.id, name: p.name, dirs: [`/synthetic/${p.id}`], personal: false })) });

/** path = 去掉 /api/v1 之后；不认的返回 null（调用方 404） */
export async function navRoute(path: string, world = navWorld(), o: NavOptions = {}): Promise<Response | null> {
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const team = o.team !== false;
  if (path === "/projects") return json({ ok: true, projects: NAV_PROJECTS });
  if (path === "/unread") return json({ counts: UNREAD });
  if (path === "/peers/contacts") {
    return o.contacts === 403 ? json({ ok: false, error: "forbidden" }, 403)
      : json({ contacts: [{ name: "机器 B", online: true, stale: false, agents: [] }, { name: "机器 C", online: false, stale: false, agents: [] }] });
  }
  if (path === "/shells") {
    return o.shells === 403 ? json({ ok: false, error: "forbidden" }, 403) : json({ shells: [], dirs: [{ dir: "/synthetic/home", label: "~" }], home: "/synthetic/home", max: 4 });
  }
  if (path === "/shared-ledger/context") return json({ identities: team ? [IDENTITY] : [] });
  if (path === "/shared-projects/snapshot") return team ? json(await sharedProjectsSnapshot(ports(), localSnapshot())) : json({ ok: false, error: "forbidden" }, 403);
  if (path === "/version") return json({ version: "9.9.9", commit: "fixture" });
  return todayRoute(path, world);
}

/* ---- happy-dom 挂载（tests/web-dom-phone-nav*.test.ts 共用）：React 与组件运行时按 web 的依赖树加载，本文件不静态 import web 里带 React 的模块 ---- */

interface El {
  textContent: string | null; getAttribute(n: string): string | null; hasAttribute(n: string): boolean;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; click(): void; remove(): void;
}
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }
type H = (...a: unknown[]) => unknown;
interface Act { act(fn: () => unknown): Promise<void> }
interface Store { state: { activeAgent: string; agents: unknown[] }; loadAgents(): Promise<void>; loadProjects(): Promise<void> }

export interface NavDomView {
  host: El;
  seen: { toContent: number; toList: number; open: string | null; store: Store | null };
  click(el: El | null | undefined, what: string): Promise<void>;
  /** 整个 body 里找（菜单、弹窗 portal 到 body） */
  all(sel: string): El[];
  texts(sel: string): string[];
  /** 整个 body 的字（弹窗 portal 在 host 外） */
  bodyText(): string;
  until(ok: () => boolean, what: string): Promise<void>;
  unmount(): Promise<void>;
}

/** beforeAll 里调一次：注册 happy-dom、拦 fetch（夹具 navRoute，之外 404）、返回挂载函数；o 可在用例之间改（contacts / shells / team） */
export async function navDom(o: NavOptions) {
  const { createRequire } = await import("node:module");
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  const { machines } = await import("../../web/lib/machines");
  const { setAppConfigForTest } = await import("../../web/lib/app-config");
  const { setContextRequestForTest } = await import("../../web/lib/collab-source-binding");
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
  const React = webRequire("react") as Act & { createElement: H };
  const { createRoot } = webRequire("react-dom/client") as { createRoot(el: unknown): { render(n: unknown): void; unmount(): void } };
  const doc = (globalThis as unknown as { document: Doc }).document;
  const win = (globalThis as unknown as { window: { happyDOM: { setViewport(v: { width: number; height: number }): void } } }).window;
  const realFetch = globalThis.fetch, realFp = machines.currentFp;
  const world = navWorld(), calls: string[] = [];
  machines.currentFp = () => "local";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
    const path = url.pathname.replace(/^\/m\/[^/]+/, "");
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${path}`);
    if (path === "/app-config.json") return Response.json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    const api = path.startsWith("/api/v1/") ? path.slice("/api/v1".length) : null;
    return (api && await navRoute(api, world, o)) || Response.json({ ok: false, error: "not in fixture" }, { status: 404 });
  }) as typeof fetch;
  const mods = {
    sidebar: require("../../web/features/chat/components/sidebar.tsx"), store: require("../../web/features/chat/chat-store.ts"),
    nav: require("../../web/features/chat/components/nav-context.tsx"), asks: require("../../web/features/asks/asks-store.ts"),
    collab: require("../../web/features/collab/collab-nav.ts"), entry: require("../../web/features/collab/team-view-entry.tsx"),
  };
  const live = new Set<() => Promise<void>>();
  const tick = (ms = 20) => React.act(() => new Promise<void>((r) => setTimeout(r, ms)));
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 200; i++) { if (ok()) return; await tick(); }
    throw new Error(`timeout waiting for ${what}`);
  };
  async function mount(width: number): Promise<NavDomView> {
    win.happyDOM.setViewport({ width, height: width < 640 ? 844 : 800 });
    setContextRequestForTest(null);
    await React.act(async () => mods.collab.closeCollab());
    const seen: NavDomView["seen"] = { toContent: 0, toList: 0, open: null, store: null };
    const h = React.createElement;
    function Probe() {
      seen.store = mods.store.useChatStoreApi();
      seen.open = mods.collab.useCollabNav().project;
      return null;
    }
    const host = doc.createElement("div");
    doc.body.appendChild(host);
    const root = createRoot(host);
    const unmount = async () => {
      if (!live.delete(unmount)) return;
      await React.act(async () => root.unmount());
      host.remove();
    };
    live.add(unmount);
    const nav = { showContent: false, toContent: () => { seen.toContent++; }, toList: () => { seen.toList++; } };
    await React.act(async () => root.render(h(mods.store.ChatStoreProvider, null, h(mods.nav.ChatNavContext.Provider, { value: nav }, h(Probe),
      h(mods.sidebar.Sidebar, { onSelect: nav.toContent })))));
    await React.act(async () => { await Promise.all([seen.store!.loadAgents(), seen.store!.loadProjects(), mods.asks.asksStore.refresh()]); });
    const all = (sel: string) => Array.from(doc.body.querySelectorAll(sel));
    return {
      host, seen, all, until, unmount,
      texts: (sel) => all(sel).map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim()),
      bodyText: () => doc.body.textContent ?? "",
      click: async (el, what) => {
        if (!el) throw new Error(`no ${what}`);
        await React.act(async () => el.click());
        await tick(30);
      },
    };
  }
  /** afterEach：卸掉本文件挂的根和项目组入口的常驻小根 */
  const cleanup = async () => {
    for (const off of [...live]) await off();
    await React.act(async () => mods.entry.unmountOpenViewGuardForTest());
  };
  /** afterAll：还原 fetch / machines / 模块级缓存，注销 happy-dom */
  const dispose = async () => {
    globalThis.fetch = realFetch;
    machines.currentFp = realFp;
    setContextRequestForTest(null);
    setAppConfigForTest(null);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    await GlobalRegistrator.unregister();
  };
  return { React, mount, cleanup, dispose, calls, tick };
}
