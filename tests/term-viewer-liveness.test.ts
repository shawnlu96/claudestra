/**
 * 终端 viewer 的回收（bridge/term-viewer.ts + term-liveness.ts）：客户端消失（半开，不 cancel 不 abort）按存活超时回收、
 * 同一设备凭据满额让最早的让位、正常关闭不双 destroy。tmux 全部替身（term-fit.ts mock），PTY 里跑的是 sleep，不碰任何 tmux server。
 */
import { afterEach, expect, mock, setSystemTime } from "bun:test";
import type { Principal } from "../src/lib/principals.js";
import { isolatedStateSuite } from "./isolated-state.ts";

// mock.module 是整个 bun test 进程共用的（会改掉别的文件里 api-auth 的活绑定）：整文件在子进程里跑，mock 只在子进程的 beforeAll 里装
const { beforeAll, test } = isolatedStateSuite(import.meta.path);

const tmuxCalls: string[][] = [];
let caller: Principal;
let tv: typeof import("../src/bridge/term-viewer.js");
let TERM_ALIVE_TIMEOUT_MS = 0;
beforeAll(async () => {
  const realFit = await import("../src/bridge/term-fit.js");
  mock.module("../src/bridge/term-fit.js", () => ({
    ...realFit,
    tmuxRun: async (args: string[]) => {
      tmuxCalls.push(args);
      return { code: 0, out: "", err: "" };
    },
    fitWindow: async (_v: string, _w: string, cols: number, rows: number) => ({ effCols: cols, effRows: rows, winCols: cols, winRows: rows }),
    tmuxArgs: () => ["sleep", "600"],
    restoreControlClamp: () => {},
  }));
  const realAuth = await import("../src/bridge/api-auth.js");
  mock.module("../src/bridge/api-auth.js", () => ({ ...realAuth, authenticateApi: async () => caller }));
  tv = await import("../src/bridge/term-viewer.js");
  ({ TERM_ALIVE_TIMEOUT_MS } = await import("../src/bridge/term-liveness.js"));
});

const target = { authAgent: "x", label: 'agent "x"', resolve: async () => "master:1" };
const device = (credential: string): Principal => ({ id: "owner:self", name: "owner", role: "owner", agents: ["*"], createdAt: "", credential }) as Principal;
const bearer = (id: string): Principal => ({ id: `token:${id}`, name: id, role: "owner", agents: ["*"], createdAt: "" }) as Principal;

type Reader = ReturnType<NonNullable<Response["body"]>["getReader"]>;
const readers: Reader[] = [];
afterEach(async () => {
  setSystemTime();
  for (const r of readers.splice(0)) await r.cancel().catch(() => { /* 已被回收 / 驱逐的流早关了，再 cancel 报错无妨 */ });
  await Bun.sleep(20);
  tmuxCalls.length = 0;
});

async function open(p: Principal, ka = true): Promise<{ status: number; id?: string; reader?: Reader }> {
  const res = await tv.openTerminal(p, new URL(`http://x/t?cols=80&rows=24${ka ? "&ka=1" : ""}`), target);
  if (res.status !== 200) return { status: res.status };
  const reader = res.body!.getReader();
  readers.push(reader);
  let buf = "";
  while (!buf.includes('"t":"open"')) buf += new TextDecoder().decode((await reader.read()).value);
  return { status: 200, id: /"id":"([0-9a-f]+)"/.exec(buf)![1], reader };
}
/** destroy 跑了几次 = 这个 viewer 的 kill-session 调了几次 */
const destroys = (id: string) => tmuxCalls.filter((a) => a[0] === "kill-session" && a[2] === `webterm-${id}`).length;
const io = (id: string, kind: "alive" | "input", p: Principal) => {
  caller = p;
  const body = kind === "input" ? { d: Buffer.from("a").toString("base64") } : {};
  return tv.handleTermIo(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), id, kind);
};

test("客户端消失（ka=1，不 cancel 不 abort）：超时前不收，超时后回收一次；再巡检、再 cancel 都不重复 destroy", async () => {
  const t = await open(device("dev_a"));
  tv.reapIdleTerminalSessions(Date.now() + TERM_ALIVE_TIMEOUT_MS - 1_000);
  expect(destroys(t.id!)).toBe(0);
  tv.reapIdleTerminalSessions(Date.now() + TERM_ALIVE_TIMEOUT_MS + 1);
  expect(destroys(t.id!)).toBe(1);
  tv.reapIdleTerminalSessions(Date.now() + 10 * TERM_ALIVE_TIMEOUT_MS);
  await t.reader!.cancel();
  await Bun.sleep(20);
  expect(destroys(t.id!)).toBe(1);
});

test("没带 ka=1 的老客户端不按存活回收", async () => {
  const t = await open(device("dev_a"), false);
  tv.reapIdleTerminalSessions(Date.now() + 10 * TERM_ALIVE_TIMEOUT_MS);
  expect(destroys(t.id!)).toBe(0);
});

test("alive / input 续命；别的凭据发的 alive 被拒且不续命", async () => {
  const t0 = Date.now();
  const t = await open(device("dev_a"));
  setSystemTime(new Date(t0 + 60_000));
  expect((await io(t.id!, "alive", device("dev_b"))).status).toBe(403);
  tv.reapIdleTerminalSessions(t0 + TERM_ALIVE_TIMEOUT_MS + 1_000);
  expect(destroys(t.id!)).toBe(1); // 别人的 alive 没算数：按打开时间超时
  setSystemTime();
  const t1 = Date.now();
  const u = await open(device("dev_a"));
  setSystemTime(new Date(t1 + 60_000));
  expect((await io(u.id!, "alive", device("dev_a"))).status).toBe(200);
  tv.reapIdleTerminalSessions(t1 + 60_000 + TERM_ALIVE_TIMEOUT_MS - 1_000); // 没续命的话这时已超时
  expect(destroys(u.id!)).toBe(0);
  setSystemTime(new Date(t1 + 120_000));
  expect((await io(u.id!, "input", device("dev_a"))).status).toBe(200);
  tv.reapIdleTerminalSessions(t1 + 120_000 + TERM_ALIVE_TIMEOUT_MS - 1_000);
  expect(destroys(u.id!)).toBe(0);
  tv.reapIdleTerminalSessions(t1 + 120_000 + TERM_ALIVE_TIMEOUT_MS + 1);
  expect(destroys(u.id!)).toBe(1);
});

test("正常关闭（读端 cancel）只 destroy 一次，之后巡检不再碰", async () => {
  const t = await open(bearer("tok_a"));
  await t.reader!.cancel();
  await Bun.sleep(20);
  expect(destroys(t.id!)).toBe(1);
  tv.reapIdleTerminalSessions(Date.now() + 10 * TERM_ALIVE_TIMEOUT_MS);
  expect(destroys(t.id!)).toBe(1);
});

test("同一设备凭据满额再开：驱逐它自己最早的那个，新的开成功；别的凭据的 viewer 不受影响", async () => {
  const other = await open(device("dev_b"));
  const mine = [];
  for (let i = 0; i < 7; i++) mine.push(await open(device("dev_a")));
  const next = await open(device("dev_a"));
  expect(next.status).toBe(200);
  expect(destroys(mine[0].id!)).toBe(1);
  for (const m of mine.slice(1)) expect(destroys(m.id!)).toBe(0);
  expect(destroys(other.id!)).toBe(0);
});

test("满额且全是别人的 → 照旧 429，谁都不动；Bearer token 满额也不驱逐自己的", async () => {
  const others = [];
  for (let i = 0; i < 8; i++) others.push(await open(device("dev_b")));
  expect((await open(device("dev_a"))).status).toBe(429);
  expect((await open(bearer("tok_a"))).status).toBe(429);
  for (const o of others) expect(destroys(o.id!)).toBe(0);
  for (const r of readers.splice(0)) await r.cancel();
  await Bun.sleep(20);
  const mine = [];
  for (let i = 0; i < 8; i++) mine.push(await open(bearer("tok_a")));
  expect((await open(bearer("tok_a"))).status).toBe(429);
  for (const m of mine) expect(destroys(m.id!)).toBe(0);
});
