/**
 * agents-MACHGEN1：切机窗口内旧页面的操作不得发到新机器（机器代际校验）。
 * machines.setCurrent 先换当前、代际 +1，持久化（backend.put / setCurrent）挂起时聊天 store 还没清，页面仍是旧机器的。
 * 这里只测纯逻辑：机器代际、lib/machine-guard.ts、api() 的 expect、chat-store-machine.ts 的 PageMachine；
 * 真 store + 菜单 / composer / 协作页叫停的 DOM 覆盖在 tests/web-dom-row-more.test.ts。
 * 一律内存 backend + 假 fetch，不连真实中继；用的是 lib/machines.ts 的单例（api() 读它），每个用例后复原。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setAppConfigForTest, type AppConfig } from "@/lib/app-config";
import { api, ApiError } from "@/lib/api/client";
import { assertMachine, captureMachine, isMachineSwitched, machineSwitched, MACHINE_SWITCHED_TEXT } from "@/lib/machine-guard";
import { machines, type MachinesBackend } from "@/lib/machines";
import { actionErrorText, PageMachine } from "@/features/chat/chat-store-machine";

const RELAY: AppConfig = { mode: "relay", relayBase: "relay.test", version: "" };
const DIRECT: AppConfig = { mode: "direct", fp: "local", machineName: "here", version: "" };
const A = "aaaa-1111";
const B = "bbbb-2222";

const backend = Reflect.get(machines, "backend") as MachinesBackend;
const realPut = backend.put;
const realSetCurrent = backend.setCurrent;
/** 机器持久化挂起：返回不 resolve 的 Promise（存储慢 / 卡住时切机窗口无限长） */
function hangPersistence(): void {
  backend.put = () => new Promise<void>(() => {});
  backend.setCurrent = () => new Promise<void>(() => {});
}

const realFetch = globalThis.fetch;
let calls: string[] = [];
let configGate: Promise<void> | null = null;
function fakeFetch(input: unknown, init?: { method?: string }): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url === "/app-config.json") return (configGate ?? Promise.resolve()).then(() => Response.json(RELAY));
  calls.push(`${init?.method ?? "GET"} ${url}`);
  return Promise.resolve(Response.json({ ok: true }));
}
const interrupt = (init: Parameters<typeof api>[1] = {}) => api("/agents/dev-a/interrupt", { method: "POST", json: {}, ...init });

beforeEach(async () => {
  backend.put = realPut;
  backend.setCurrent = realSetCurrent;
  calls = [];
  configGate = null;
  globalThis.fetch = fakeFetch as typeof fetch;
  setAppConfigForTest(RELAY);
  await machines.add({ fp: A, name: "Mac A" });
  await machines.add({ fp: B, name: "Mac B" });
  await machines.setCurrent(A);
});

afterEach(async () => {
  backend.put = realPut;
  backend.setCurrent = realSetCurrent;
  await machines.remove(A);
  await machines.remove(B);
  setAppConfigForTest(null);
  globalThis.fetch = realFetch;
});

describe("机器代际（lib/machines.ts）", () => {
  test("[验收线 1] 持久化挂起：setCurrent 一进来就换当前、代际 +1；切换监听看到的已是新机器", () => {
    hangPersistence();
    const before = machines.generation();
    let seen: [string | null, number] | null = null;
    const off = machines.onSwitch(() => (seen = [machines.currentFp(), machines.generation()]));
    void machines.setCurrent(B); // 不 await：持久化永远不完
    off();
    expect(machines.currentFp()).toBe(B);
    expect(machines.generation()).toBe(before + 1);
    expect(seen as [string | null, number] | null).toEqual([B, before + 1]);
  });
  test("[验收线 2] 只增不复用：A→B→A 后 A 第一次的代际不再有效；同机器 setCurrent 不涨", async () => {
    const first = captureMachine();
    await machines.setCurrent(A);
    expect(machines.generation()).toBe(first.gen);
    await machines.setCurrent(B);
    await machines.setCurrent(A);
    expect(machines.currentFp()).toBe(A);
    expect(machines.generation()).toBe(first.gen + 2);
    expect(machineSwitched(first)).toBe(true);
    expect(machineSwitched(captureMachine())).toBe(false);
  });
});

describe("api() 的 expect（lib/api/client.ts）", () => {
  test("[验收线 1] 旧代际：A、B 都收不到 interrupt POST，抛 machine_switched（notSent）", async () => {
    const page = captureMachine();
    hangPersistence();
    void machines.setCurrent(B);
    const err = await interrupt({ expect: page }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("machine_switched");
    expect(isMachineSwitched(err)).toBe(true);
    expect(calls).toEqual([]);
  });
  test("[验收线 2] 等 loadAppConfig 期间切机：配置到了也不发往新机器（零请求）", async () => {
    setAppConfigForTest(null);
    let open!: () => void;
    configGate = new Promise<void>((r) => (open = r));
    const page = captureMachine();
    const pending = interrupt({ expect: page }).catch((e: unknown) => e);
    await machines.setCurrent(B);
    open();
    expect(isMachineSwitched(await pending)).toBe(true);
    expect(calls).toEqual([]);
  });
  test("[验收线 2] 快速 A→B→A：A 第一次的旧操作不恢复有效；A 新捕获的照常只发一次、发往 A", async () => {
    const stale = captureMachine();
    await machines.setCurrent(B);
    await machines.setCurrent(A);
    expect(isMachineSwitched(await interrupt({ expect: stale }).catch((e: unknown) => e))).toBe(true);
    expect(calls).toEqual([]);
    await interrupt({ expect: captureMachine() });
    expect(calls).toEqual([`POST /m/${A}/api/v1/agents/dev-a/interrupt`]);
  });
  test("[验收线 2] 目标取 expect.fp，不读发请求时的当前机器", async () => {
    const page = captureMachine();
    hangPersistence();
    void machines.setCurrent(B);
    void machines.setCurrent(A); // 回到 A，但代际已变
    expect(isMachineSwitched(await interrupt({ expect: page }).catch((e: unknown) => e))).toBe(true);
    expect(calls.filter((c) => c.includes(B))).toEqual([]);
    expect(calls).toEqual([]);
  });
  test("[验收线 4] B 页面载入后（新捕获）：打断正常发送且只发送一次，发往 B", async () => {
    await machines.setCurrent(B);
    await interrupt({ expect: captureMachine() });
    expect(calls).toEqual([`POST /m/${B}/api/v1/agents/dev-a/interrupt`]);
  });
  test("[验收线 4] 直托管：expect 不生效，行为不变（同源根）", async () => {
    setAppConfigForTest(DIRECT);
    const page = captureMachine();
    await machines.setCurrent(B);
    expect(machineSwitched(page)).toBe(false);
    expect(() => assertMachine(page)).not.toThrow();
    await interrupt({ expect: page });
    expect(calls).toEqual(["POST /api/v1/agents/dev-a/interrupt"]);
  });
  test("[验收线 5] 不带 expect：照旧在发请求时取当前机器", async () => {
    await machines.setCurrent(B);
    await interrupt();
    expect(calls).toEqual([`POST /m/${B}/api/v1/agents/dev-a/interrupt`]);
  });
  test("在途时切机的迟到响应仍是 machine_switched，但请求已发出：不算「操作未发送」", async () => {
    let answer!: () => void;
    globalThis.fetch = ((input: unknown) => {
      calls.push(String(input));
      return new Promise<Response>((r) => (answer = () => r(Response.json({ ok: true }))));
    }) as typeof fetch;
    const pending = interrupt({ expect: captureMachine() }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(1);
    void machines.setCurrent(B);
    answer();
    const err = await pending;
    expect((err as ApiError).code).toBe("machine_switched");
    expect(isMachineSwitched(err)).toBe(false);
    expect(actionErrorText(err)).not.toBe(MACHINE_SWITCHED_TEXT);
  });
});

describe("PageMachine（chat-store 的页面机器）", () => {
  test("[验收线 1] 记下 A 后切到 B：拒绝 + 留一句轻提示；换数据源（resetForMachine）后放行", () => {
    const notes: string[] = [];
    const pm = new PageMachine((t) => notes.push(t));
    expect(pm.refusal()).toBeNull(); // 还没记过：不核，与改前一致
    expect(pm.expect).toBeUndefined();
    pm.adoptOnce();
    hangPersistence();
    void machines.setCurrent(B);
    pm.adoptOnce(); // 已记过 A：首次打开之后再开会话不换
    expect(pm.expect?.fp).toBe(A);
    expect(pm.refusal()).toEqual({ ok: false, error: MACHINE_SWITCHED_TEXT });
    expect(notes).toEqual([MACHINE_SWITCHED_TEXT]);
    pm.adopt();
    expect(pm.refusal()).toBeNull();
    expect(pm.expect).toEqual({ fp: B, gen: machines.generation() });
  });
  test("actionErrorText：发出前被拒的统一文案，其余照旧", () => {
    expect(actionErrorText(new ApiError("machine switched — request not sent", 0, { notSent: true }, "machine_switched"))).toBe(MACHINE_SWITCHED_TEXT);
    expect(actionErrorText(new Error("boom"))).toBe("boom");
    expect(actionErrorText(new Error(""))).toBe("操作失败");
  });
});
