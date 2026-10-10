/** Real components and API clients, loopback-only synthetic fixture. UNREAD_BROWSER=1 enables Chrome and six evidence shots. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { shotIssues } from "./helpers/ui-shot-checks";
const enabled = process.env.UNREAD_BROWSER === "1";
const baseline = "65161e2a7e6a152a9fa2737446a96201a6fa9658";
const web = resolve("web"), out = resolve(".work-evidence/ui");
let browser: Browser;
const servers: Record<string, ReturnType<typeof Bun.serve>> = {};
const shots: Array<Record<string, unknown>> = [];
const hash = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
const fixture = `
import React, { useState } from "react";import { createRoot } from "react-dom/client";
import { setLang } from "@/lib/i18n";
import { SidebarAdminButtons } from "./sidebar-admin-buttons";
import { ProjectGroup } from "./project-group";
import { TeamGroup, MasterTeam } from "./team-group";
import { SidebarDirectory } from "./sidebar-history";
import { UnreadPill } from "./unread-pill";
import { setUnreadCounts, clearUnreadCounts, unreadSnapshot, loadUnreadCounts } from "@/lib/push/unread-counts";
import { loadAgents } from "@/lib/chat/agents";
import { cleanupReadNotifications, clearDeliveredNotifications } from "@/lib/push/client";
import { cleanupDeliveredNative, clearDeliveredNative } from "@/lib/push/native";
import { machines } from "@/lib/machines";
setLang("zh");document.documentElement.dataset.theme = "light";
const initial = { one:1, two:3, kid:2, old:1 };
const ag = (name, p={}) => ({name,displayName:name,purpose:"",cwd:"",status:"active",...p});
window.scenario = { counts:initial, agents:[ag("agent-one"),ag("two"),ag("lead"),ag("kid",{parent:"lead"}),ag("old",{status:"stopped"}),ag("master")], reads:{}, asks:[], full:true };
window.calls = {};window.closedNotifications = [];window.removed = [];window.removeAll = 0;window.refreshes = 0;window.full = true;
window.notifications = [];
window.nativeMode = (on) => { window.Capacitor = on ? {isNativePlatform:()=>true, Plugins:{PushNotifications:{
  getDeliveredNotifications:async()=>({notifications:window.notifications.map((data,id)=>({id:String(id),data}))}),
  removeDeliveredNotifications:async({notifications})=>window.removed.push(...notifications.map(n=>Number(n.id))),
  removeAllDeliveredNotifications:async()=>{if(window.failLocal)throw new Error("plugin failed");window.removeAll++}
}}}:undefined; };
Object.defineProperty(navigator.serviceWorker, "getRegistration", {value:async()=>({
 getNotifications:async()=>{
  if(window.failLocal)throw new Error("notification API failed");
  return window.notifications.map((data,id)=>({data,close:()=>window.closedNotifications.push(id)}))
 }
})});
window.fetch = async (input, init={}) => {
  const path = new URL(String(input), location.href).pathname;
  window.calls[path] = (window.calls[path]||0)+1;
  const s = window.scenario;
  if (path === "/app-config.json") return Response.json({mode:"direct",fp:"local",machineName:"Fixture"});
  if (s.fail?.[path] === "offline") throw new Error("offline");
  if (s.fail?.[path] === "timeout") return new Promise((res, rej)=>init.signal.addEventListener("abort",()=>rej(new DOMException("timeout","AbortError")),{once:true}));
  if (typeof s.fail?.[path] === "number") return Response.json({error:"unavailable"},{status:s.fail[path]});
  if (path === "/api/v1/agents/read-all") {
    if (s.delay) await new Promise(r=>setTimeout(r,s.delay));
    s.counts = {}; return Response.json({ok:true,cleared:4});
  }
  if (path === "/api/v1/unread") {
    const counts=s.counts;
    if(s.unreadDelay)await new Promise(r=>{window.releaseUnread=r;(window.unreadReleases??=[]).push(r)});
    return Response.json({counts});
  }
  if (path === "/api/v1/agents") return Response.json({ok:true,agents:s.agents});
  if (path === "/api/v1/reads") return Response.json({reads:s.reads});
  if (path === "/api/v1/asks") return Response.json({ok:true,asks:s.asks,full:s.full,now:Date.now()});
  return Response.json({ok:true});
};
window.test = { loadAgents, cleanupReadNotifications, cleanupDeliveredNative, clearDeliveredNotifications, clearDeliveredNative,
  setUnreadCounts, clearUnreadCounts, unreadSnapshot, loadUnreadCounts, machines };
const no = ()=>{};
const row = (a,s) => <li key={a.name} data-agent={a.name} className="flex items-center gap-2 rounded-lg bg-base-100/60 px-2 py-1.5 text-sm">
  {s?.lead}<span>{a.name}</span><span className="ml-auto">{s?.tail}</span><UnreadPill count={a.unread||0}/>
</li>;
function App(){
 const [list,setList]=useState([]); const [collapsed,setCollapsed]=useState(true); const [masterFold,setMasterFold]=useState(true);
 window.rerender=()=>setList([...list]);window.setCollapsed=setCollapsed;
 window.updateRows=async()=>setList(await loadAgents());
 React.useEffect(()=>{window.updateRows().then(()=>window.ready=true)},[]);
 const by=(n)=>list.find(a=>a.name===n)||ag(n);
 const nodes=[{a:by("one"),children:[]},{a:by("two"),children:[]}];
 const group={kind:"group",id:"p",meta:{name:"Project p",emoji:"",dirs:[]},nodes,items:nodes.map(n=>n.a)};
 const team={kind:"row",a:by("lead"),children:[by("kid")]};
 const history=[{kind:"row",a:by("old"),children:[]}];
 const folds={projects:new Set(["p"]),teams:new Set(["lead"]),toggleProject:no,toggleTeam:no};
 const render=(e)=>e.kind==="group"?<ProjectGroup key={e.id} e={e} collapsed={collapsed} groupBusy={false} onToggle={()=>setCollapsed(!collapsed)}>{e.items.map(a=>row(a))}</ProjectGroup>
 :<TeamGroup key={e.a.name} node={e} collapsed={collapsed} busy={false} onToggle={()=>setCollapsed(!collapsed)} row={row}/>;
 return <div className="min-h-screen bg-base-100 text-base-content">
 <div className="bg-warning px-3 py-1 text-xs font-semibold text-black">合成夹具 · 非生产页面 · PUSHCLR1</div>
 <aside className="flex w-full flex-col bg-base-200 px-4 py-3 sm:w-64">
 <div className="mb-3 flex items-center justify-end" data-topbar>
 <SidebarAdminButtons manage={false} onProjects={no} onToggleManage={no} onPeers={no} onStats={no}/>
 {["壳","媒体","设置"].map(x=><button key={x} title={x}
  className="flex size-7 shrink-0 items-center justify-center rounded-lg text-base-content/50">
  <svg width="16" height="16"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor"/></svg></button>)}
 </div>
 <SidebarDirectory activeEntries={[group,team]} historyEntries={history} historyCount={1} activeFolds={folds} renderEntry={render}/>
 <div data-master><MasterTeam masterName="__master__" kids={window.masterKids||[]} collapsed={masterFold} busy={false} onToggle={()=>setMasterFold(!masterFold)} row={row}/></div>
 </aside></div>;
}
createRoot(document.getElementById("root")).render(<App/>);
`;
const replacements = ["project-group.tsx", "team-group.tsx", "sidebar-history.tsx", "sidebar-admin-buttons.tsx"];

async function build(phase: string) {
  const old: Record<string, string> = {};
  if (phase === "before") for (const path of [
    ...replacements.map((f) => `web/features/chat/components/${f}`), "web/lib/chat/agents.ts", "web/lib/push/client.ts", "web/lib/push/native.ts",
  ]) {
    const p = Bun.spawn(["git", "show", `${baseline}:${path}`], { stdout: "pipe" });
    old[resolve(path)] = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
  }
  const stubs = {
    "agent-dnd": "export const useAgentDrop=()=>({over:false,handlers:{}});",
    "project-menu": "export const useProjectMenuTrigger=()=>({consumedClick:()=>false,handlers:{}});",
    "host-info": "export const useHostInfo=()=>({local:false,openers:[]});",
    "contacts-data": "export const useFullScope=()=>window.full;",
    "team-view-entry": "export const UnifiedCollabEntry=()=>null;",
    "peers-button": "import React from 'react';export const PeersButton=()=>React.createElement('span',{className:'size-7 shrink-0',title:'Peer'});",
    "chat-store": "export const useChatStoreApi=()=>({refreshAgents:async()=>{window.refreshes++;await window.updateRows();}});",
  };
  const entry = join(web, "features/chat/components/.pushclr-entry.tsx");
  const script = join(out, `build-${phase}.ts`);
  writeFileSync(entry, phase === "before" ? fixture.replaceAll(", clearDeliveredNotifications", "").replaceAll(", clearDeliveredNative", "") : fixture);
  writeFileSync(script, `const old=${JSON.stringify(old)},stubs=${JSON.stringify(stubs)};
const plugin={name:'fixture',setup(b){
 b.onResolve({filter:/(^|\\/)(agent-dnd|project-menu|host-info|contacts-data|team-view-entry|peers-button|chat-store)$/},a=>({path:a.path.split('/').pop(),namespace:'stub'}));
 b.onLoad({filter:/.*/,namespace:'stub'},a=>({contents:stubs[a.path],loader:'tsx',resolveDir:${JSON.stringify(web)}}));
 b.onLoad({filter:/\\.(tsx|ts)$/},a=>old[a.path]?{contents:old[a.path],loader:a.path.endsWith('tsx')?'tsx':'ts'}:undefined);
}};
const r=await Bun.build({entrypoints:[${JSON.stringify(entry)}],outdir:${JSON.stringify(out)},naming:${JSON.stringify(`${phase}.js`)},
 target:'browser',plugins:[plugin],define:{'process.env.NODE_ENV':'"production"'}});
if(!r.success){console.error(r.logs.map(String).join('\\n'));process.exit(1);}`);
  try {
    const p = Bun.spawn([process.execPath, script], { cwd: web, stdout: "pipe", stderr: "pipe" });
    const err = await new Response(p.stderr).text();
    if (await p.exited) throw new Error(err);
  } finally { unlinkSync(entry); }
}

beforeAll(async () => {
  if (!enabled) return;
  mkdirSync(out, { recursive: true });
  const req = createRequire(join(web, "package.json"));
  const from = join(web, "app/globals.css");
  const css = (await req("postcss")([req("@tailwindcss/postcss")({ base: web })]).process(readFileSync(from, "utf8") + '\n@source inline("sm:w-64");\n', { from })).css;
  for (const phase of ["before", "after"]) {
    await build(phase);
    servers[phase] = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(r) {
      if (new URL(r.url).pathname === "/fixture.js") return new Response(Bun.file(join(out, `${phase}.js`)));
      return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
    } });
  }
  browser = await chromium.launch({ headless: true, channel: "chrome" });
}, 120_000);
afterAll(async () => {
  if (!enabled) return;
  await browser?.close();
  for (const server of Object.values(servers)) server.stop(true);
  const evidence = { v: 1, taskId: "peer-PUSHCLR1", specRev: 1, baseline, fixtureSha256: hash(fixture), shots };
  writeFileSync(join(out, "manifest.json"), JSON.stringify({ ...evidence, digest: hash(JSON.stringify(evidence)) }, null, 2));
});
async function page(phase = "after", width = 1280) {
  const p = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 1 });
  const blocked: string[] = [], errors: string[] = [];
  await p.route("**/*", (r) => {
    if (new URL(r.request().url()).hostname !== "127.0.0.1") { blocked.push(r.request().url()); return r.abort(); }
    return r.continue();
  });
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${servers[phase].port}/`);
  await p.waitForFunction("window.ready === true");
  return { p, blocked, errors };
}
async function shot(p: Page, phase: string, width: number, view: string) {
  expect(await shotIssues(p)).toEqual([]);
  const ref = `${phase}-${width}-${view}.png`;
  const png = await p.screenshot({ path: join(out, ref) });
  shots.push({ phase, ref, size: `${width}x800`, view, sha256: hash(png), shotIssues: [], nonLoopbackRequests: 0 });
}
async function evaluate<T = unknown>(p: Page, script: string): Promise<T> {
  return p.evaluate<T>(script.startsWith("async()=>") || script.startsWith("()=>") ? `(${script})()` : script);
}
const pill = "span.bg-accent";

test.skipIf(!enabled)("[验收线 3] [验收线 6] [验收线 8] same fixture: baseline missing badges/button; new 4/2/1 and clear-all", async () => {
  for (const width of [1280, 390]) for (const phase of ["before", "after"]) {
    const { p, blocked, errors } = await page(phase, width);
    const button = p.getByRole("button", { name: "全部已读", exact: true });
    if (phase === "before") {
      await expect(button.count()).resolves.toBe(0);
      expect(await p.locator(pill).allTextContents()).toEqual([]);
    } else {
      expect(await button.getAttribute("title")).toBe("全部已读");
      expect(await p.locator(pill).allTextContents()).toEqual(["4", "2", "1"]);
      await p.keyboard.press("Tab");
      expect(await evaluate<string>(p, "document.activeElement.getAttribute('aria-label')")).toBe("全部已读");
    }
    await shot(p, phase, width, "unread");
    if (phase === "after") {
      await button.click();
      await p.waitForFunction("window.test.unreadSnapshot().total === 0 && window.refreshes === 1");
      await p.waitForFunction("window.refreshes === 1");
      expect(await p.locator(pill).allTextContents()).toEqual([]);
      expect(await evaluate<number>(p, "window.calls['/api/v1/agents/read-all']")).toBe(1);
      await shot(p, phase, width, "read-all");
    }
    expect(blocked).toEqual([]); expect(errors).toEqual([]); await p.close();
  }
}, 120_000);

test.skipIf(!enabled)("[验收线 2] merge bare-name unread, archived total, 404/timeout fallback, 403 stops polling", async () => {
  const { p } = await page();
  const r = await evaluate(p, `async()=>{
    window.scenario.counts={one:2,two:1,archived:5,master:0};
    const list=await window.test.loadAgents();const total=window.test.unreadSnapshot().total;
    window.scenario.fail={'/api/v1/unread':404};const missing=await window.test.loadAgents();
    window.scenario.fail={'/api/v1/unread':'timeout'};const timed=await window.test.loadAgents(undefined,25);
    window.scenario.fail={'/api/v1/unread':403};await window.test.loadAgents();const n=window.calls['/api/v1/unread'];
    await window.test.loadAgents();
    return {one:list.find(a=>a.name==='one').unread,two:list.find(a=>a.name==='two').unread,master:list.find(a=>a.name==='__master__').unread,
     total,missing:missing.length,timed:timed.length,stopped:window.calls['/api/v1/unread']===n};
  }`);
  expect(r).toEqual({ one: 2, two: 1, master: undefined, total: 8, missing: 6, timed: 6, stopped: true });
  await p.close();
}, 30_000);

test.skipIf(!enabled)("[验收线 2] overlapping list and foreground cleanup retain row unread in either response order", async () => {
  for (const reverse of [false, true]) {
    const { p } = await page();
    const r = await evaluate(p, `async()=>{
      window.test.machines.currentFp=()=> 'here';window.test.machines.all=()=>[{}];
      window.notifications=[{agent:'one',ts:Date.now(),fp:'here'}];
      window.scenario.counts={one:2,two:1};window.scenario.unreadDelay=true;window.unreadReleases=[];
      const list=window.test.loadAgents();
      while(window.unreadReleases.length<1)await new Promise(r=>setTimeout(r,0));
      const cleanup=window.test.cleanupReadNotifications();
      while(window.unreadReleases.length<2)await new Promise(r=>setTimeout(r,0));
      if(${reverse}){window.unreadReleases[1]();await cleanup;window.unreadReleases[0]();}
      else{window.unreadReleases[0]();await list;window.unreadReleases[1]();}
      const rows=await list;await cleanup;
      return {one:rows.find(a=>a.name==='one').unread,two:rows.find(a=>a.name==='two').unread,
        total:window.test.unreadSnapshot().total,closed:window.closedNotifications};
    }`);
    expect(r).toEqual({ one: 2, two: 1, total: 3, closed: [] });
    await p.close();
  }
}, 30_000);

test.skipIf(!enabled)("[验收线 2] older unread cannot overwrite newer counts and clear-all invalidates pending reads", async () => {
  const { p } = await page();
  const r = await evaluate(p, `async()=>{
    window.scenario.unreadDelay=true;window.unreadReleases=[];window.scenario.counts={one:2};
    const old=window.test.loadAgents();
    while(window.unreadReleases.length<1)await new Promise(r=>setTimeout(r,0));
    window.scenario.counts={one:5};const newer=window.test.loadAgents();
    while(window.unreadReleases.length<2)await new Promise(r=>setTimeout(r,0));
    window.unreadReleases[1]();const newRows=await newer;
    window.unreadReleases[0]();const oldRows=await old;const total=window.test.unreadSnapshot().total;
    const pending=window.test.loadAgents();
    while(window.unreadReleases.length<3)await new Promise(r=>setTimeout(r,0));
    window.test.clearUnreadCounts();window.unreadReleases[2]();const cleared=await pending;
    return {old:oldRows.find(a=>a.name==='one').unread,new:newRows.find(a=>a.name==='one').unread,total,
      cleared:cleared.find(a=>a.name==='one').unread,after:window.test.unreadSnapshot().total};
  }`);
  expect(r).toEqual({ old: 5, new: 5, total: 5, cleared: 0, after: 0 });
  await p.close();
}, 30_000);

test.skipIf(!enabled)("[验收线 2] stalled unread has an independent short budget and does not hold the 12s agent request", async () => {
  const { p } = await page();
  const r = await evaluate<{ elapsed: number; unread: number; rows: number }>(p, `async()=>{
    window.scenario.fail={'/api/v1/unread':'timeout'};const start=performance.now();
    const rows=await window.test.loadAgents(undefined,12000);
    return {elapsed:performance.now()-start,unread:rows.find(a=>a.name==='one').unread,rows:rows.length};
  }`);
  expect(r.elapsed).toBeLessThan(2000);
  expect(r.unread).toBe(1);expect(r.rows).toBe(6);
  await p.close();
}, 30_000);

test.skipIf(!enabled)("[验收线 3] all-read permission, duplicate click guard, native/browser success, failure retains notifications", async () => {
  for (const native of [false, true]) {
    const { p } = await page();
    await evaluate(p, `()=>{window.nativeMode(${native});window.notifications=[{agent:'a'},{agent:'b'}];window.scenario.fail={'/api/v1/agents/read-all':500};}`);
    const button = p.getByRole("button", { name: "全部已读", exact: true });
    await button.click();
    await p.waitForFunction("document.querySelector('[aria-label=全部已读]')?.disabled === false");
    expect(await evaluate<{ closed: number[]; total: number; all: number; refresh: number }>(p,
      "({closed:window.closedNotifications,total:window.test.unreadSnapshot().total,all:window.removeAll,refresh:window.refreshes})"))
      .toEqual({ closed: [], total: 7, all: 0, refresh: 0 });
    await evaluate(p, "()=>{window.scenario.fail={};window.scenario.delay=100;document.querySelector('[aria-label=全部已读]').click();document.querySelector('[aria-label=全部已读]').click();}");
    await p.waitForFunction("window.test.unreadSnapshot().total === 0 && window.refreshes === 1");
    expect(await evaluate<number>(p, "window.calls['/api/v1/agents/read-all']")).toBe(2);
    expect(await evaluate<number>(p, "window.removeAll")).toBe(native ? 1 : 0);
    expect(await evaluate<number[]>(p, "window.closedNotifications")).toEqual(native ? [] : [0, 1]);
    expect(await button.count()).toBe(1);
    await p.waitForFunction("document.querySelector('[aria-label=全部已读]').disabled === false");
    // Zero unread still sends one request and clears stale local notifications.
    await evaluate(p, "()=>{window.scenario.delay=0;window.closedNotifications=[];}");
    await button.click();
    await p.waitForFunction("window.refreshes === 2");
    expect(await evaluate<number>(p, "window.calls['/api/v1/agents/read-all']")).toBe(3);
    expect(await evaluate<number>(p, "window.removeAll")).toBe(native ? 2 : 0);
    expect(await evaluate<number[]>(p, "window.closedNotifications")).toEqual(native ? [] : [0, 1]);
    await evaluate(p, "()=>{window.full=false;window.test.setUnreadCounts({a:1});window.rerender();}");
    expect(await button.count()).toBe(0);
    await p.close();
  }
}, 30_000);

interface CleanupResult { closed: number[]; removed: number[]; calls: Record<string, number> }
test.skipIf(!enabled)("[验收线 4] both paths keep unknown ages/empty registry and direct browser cleans completed asks", async () => {
  for (const native of [false, true]) {
    const { p } = await page();
    const r = await evaluate<CleanupResult>(p, `async()=>{
      window.nativeMode(${native});window.test.machines.currentFp=()=>null;window.test.machines.all=()=>[];
      window.scenario.agents=[];window.scenario.asks=[];window.scenario.full=true;
      window.notifications=[{agent:''},{agent:'',ts:0},{agent:'gone',ts:Date.now(),fp:''},
        {agent:'executor',url:'/chat?ask=done',ts:Date.now(),fp:''},
        {agent:'executor',url:'/chat?ask=done',ts:Date.now(),fp:'away'},
        {agent:'executor',url:'/chat?ask=done',ts:Date.now(),fp:'local'}];
      await window.test.cleanupReadNotifications();
      return {closed:window.closedNotifications,removed:window.removed,calls:window.calls};
    }`);
    expect(native ? r.removed : r.closed).toEqual(native ? [3, 4, 5] : [3, 5]);
    expect(r.calls['/api/v1/asks']).toBe(1);expect(r.calls['/api/v1/agents']).toBe(2);
    await p.close();
  }
}, 30_000);
const cleanupInput = `
const now=Date.now();
window.scenario.reads={water:now};window.scenario.full=true;window.scenario.asks=[{id:'open',state:'open'},{id:'done',state:'answered'}];
window.scenario.agents=[{name:'live'},{name:'master'},{name:'water'}];window.scenario.fail={};
window.notifications=[
 {agent:'water',url:'/chat?ask=open',ts:now-1,fp:'here'},
 {agent:'executor',url:'/chat?ask=done',ts:now,fp:'here'},
 {agent:'executor',ask:'open',url:'/chat?ask=open',ts:now,fp:'here'},
 {agent:'',ts:now-25*3600000,fp:'away'},
 {agent:'',ts:now-3600000,fp:'here'},
 {agent:'deleted',ts:now,fp:'here'},
 {agent:'master',ts:now,fp:'here'},
 {agent:'live',ts:now,fp:'here'},
 {agent:'executor',url:'/chat?ask=done',ts:now,fp:'away'},
 {agent:'deleted',ts:now,fp:'away'},
 {agent:'',url:'/chat?ask=open',ts:now-25*3600000,fp:'here'}
];
window.test.machines.currentFp=()=> 'here';window.test.machines.all=()=>[{}];
window.calls={};window.closedNotifications=[];window.removed=[];
`;

test.skipIf(!enabled)("[验收线 4] both cleanup paths retain open asks/master/foreign notifications and independently tolerate missing data", async () => {
  for (const native of [false, true]) {
    const { p } = await page();
    const setup = `window.nativeMode(${native});${cleanupInput}`;
    const clean = "await window.test.cleanupReadNotifications();return {closed:window.closedNotifications,removed:window.removed,calls:window.calls}";
    const result = await evaluate<CleanupResult>(p, `async()=>{${setup}${clean}}`);
    // APNs has no fp; a single-machine shell can classify every agent/ask notification.
    const expected = native ? [0, 1, 3, 5, 8, 9] : [0, 1, 3, 5];
    expect(native ? result.removed : result.closed).toEqual(expected);
    expect(result.calls["/api/v1/asks"]).toBe(1);
    expect(result.calls["/api/v1/agents"]).toBe(1);
    for (const failure of ["asks", "agents", "reads", "full"]) {
      const fail = failure === "full" ? "window.scenario.full=false;" : `window.scenario.fail['/api/v1/${failure}']='offline';`;
      const r = await evaluate<CleanupResult>(p, `async()=>{${setup}${fail}${clean}}`);
      const askDead = native ? [1, 8] : [1];
      const agentDead = native ? [5, 9] : [5];
      const dead = expected.filter(i=> failure === "reads" ? i !== 0 : failure === "agents" ? !agentDead.includes(i) : !askDead.includes(i));
      expect(native ? r.removed : r.closed).toEqual(dead);
    }
    if (native) {
      const r = await evaluate<CleanupResult>(p, `async()=>{${setup}window.test.machines.all=()=>[{},{}];${clean}}`);
      expect(r.removed).toEqual([0, 3]);
      expect(r.calls["/api/v1/asks"]).toBeUndefined();expect(r.calls["/api/v1/agents"]).toBeUndefined();
    }
    const empty = await evaluate<CleanupResult>(p, `async()=>{${setup}window.notifications=[];${clean}}`);
    expect(empty.calls).toEqual({});
    const age = await evaluate<CleanupResult>(p, `async()=>{${setup}window.notifications=[{agent:'',ts:1}];${clean}}`);
    expect(native ? age.removed : age.closed).toEqual([0]);
    expect(age.calls["/api/v1/asks"]).toBeUndefined();expect(age.calls["/api/v1/agents"]).toBeUndefined();
    await p.close();
  }
}, 30_000);

test.skipIf(!enabled)("[验收线 2] [验收线 4] baseline has no unread and clears only watermarked notifications", async () => {
  const { p } = await page("before");
  expect(await evaluate<number | null>(p, "async()=>{const l=await window.test.loadAgents();return l.find(a=>a.name==='one').unread??null;}" )).toBeNull();
  for (const native of [false, true]) {
    const r = await evaluate<CleanupResult>(p, `async()=>{window.nativeMode(${native});${cleanupInput}
      await window.test.cleanupReadNotifications();return {closed:window.closedNotifications,removed:window.removed};}`);
    expect(native ? r.removed : r.closed).toEqual([0]);
  }
  await p.close();
}, 30_000);

test.skipIf(!enabled)("[验收线 6] collapsed MasterTeam caps at 99+, teams exclude own unread, expanded groups hide totals", async () => {
  const { p } = await page();
  await evaluate(p, "()=>{window.masterKids=[{name:'kid',unread:100,parent:'__master__'}];window.rerender();}");
  expect(await p.locator("[data-master] " + pill).allTextContents()).toEqual(["99+"]);
  await p.locator("[data-master] button").click();
  expect(await p.locator("[data-master] button " + pill).count()).toBe(0);
  await evaluate(p, "()=>{window.scenario.counts={one:1,two:3,lead:10,kid:2,old:1};return window.updateRows();}");
  // The dispatcher retains its own row pill; the tail counts only children.
  expect(await p.locator("[data-agent=lead] " + pill).allTextContents()).toEqual(["2", "10"]);
  await evaluate(p, "()=>window.setCollapsed(false)");
  expect(await p.locator("[data-agent=lead] " + pill).allTextContents()).toEqual(["10"]);
  expect(await p.getByRole("button", { name: /Project p/ }).locator(pill).count()).toBe(0);
  await p.close();
}, 30_000);

test.skipIf(!enabled)("[验收线 3] successful server read-all clears counts even if local notification APIs fail", async () => {
  for (const native of [false, true]) {
    const { p } = await page();
    await evaluate(p, `()=>{window.nativeMode(${native});window.notifications=[{agent:'one',ts:Date.now()-1000}];window.failLocal=true;}`);
    const button = p.getByRole("button", { name: "全部已读", exact: true });
    await button.click();
    await p.waitForFunction("window.refreshes === 1 && window.test.unreadSnapshot().total === 0");
    expect(await evaluate<number[]>(p, "window.closedNotifications")).toEqual([]);
    expect(await evaluate<number>(p, "window.removeAll")).toBe(0);
    expect(await button.count()).toBe(1);
    await evaluate(p, "async()=>{window.failLocal=false;window.scenario.reads={one:Date.now()};await window.test.cleanupReadNotifications();}");
    expect(await evaluate<number[]>(p, native ? "window.removed" : "window.closedNotifications")).toEqual([0]);
    await p.close();
  }
}, 30_000);

test.skipIf(!enabled)("[验收线 2] per-machine 403 persists, switch clears display and late old-machine unread is discarded", async () => {
  const { p } = await page();
  const r = await evaluate<{ clear: number; b: number; aForbiddenPersists: boolean; late: number; oldResult: Record<string, number> }>(p, `async()=>{
    const m=window.test.machines;
    for(const fp of ['A','B','C'])await m.add({fp,name:fp});
    await m.setCurrent('A');window.scenario.counts={a:9};await window.test.loadUnreadCounts();
    window.scenario.fail={'/api/v1/unread':403};await window.test.loadUnreadCounts();
    await m.setCurrent('B');const clear=window.test.unreadSnapshot().total;
    window.scenario.fail={};window.scenario.counts={b:2};await window.test.loadUnreadCounts();const b=window.test.unreadSnapshot().total;
    await m.setCurrent('A');const n=window.calls['/api/v1/unread'];await window.test.loadUnreadCounts();
    const aForbiddenPersists=n===window.calls['/api/v1/unread'];
    await m.setCurrent('C');window.scenario.counts={c:99};window.scenario.unreadDelay=true;
    const pending=window.test.loadUnreadCounts();while(!window.releaseUnread)await new Promise(r=>setTimeout(r,0));
    await m.setCurrent('B');window.scenario.unreadDelay=false;window.scenario.counts={b:3};await window.test.loadUnreadCounts();
    window.releaseUnread();const oldResult=await pending;const late=window.test.unreadSnapshot().total;
    return {clear,b,aForbiddenPersists,late,oldResult};
  }`);
  expect(r).toEqual({ clear: 0, b: 2, aForbiddenPersists: true, late: 3, oldResult: {} });
  await p.close();
}, 30_000);
