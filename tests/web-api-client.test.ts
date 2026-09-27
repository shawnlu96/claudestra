import { describe, expect, test } from "bun:test";
import { machineBase, parseAppConfig, type DirectConfig } from "@/lib/app-config";
import { ApiError, apiErrorFrom, DeviceInvalidError, linkSignals } from "@/lib/api/client";
import { MachineStore, memoryBackend, pickCurrent, sortMachines, upsertRecord, type MachineRecord } from "@/lib/machines";

const fallback: DirectConfig = { mode: "direct", fp: "local", machineName: "here", version: "" };

describe("parseAppConfig（/app-config.json → 入口模式）", () => {
  test("中继：mode + relayBase 必填，其余可选字段只在有值时带上", () => {
    const c = parseAppConfig({ mode: "relay", relayBase: "relay.example.com", version: "2.28.0", vapidPublicKey: "BKey" }, fallback);
    expect(c).toEqual({ mode: "relay", relayBase: "relay.example.com", version: "2.28.0", vapidPublicKey: "BKey" });
  });
  test("直托管：fp / machineName 缺了用兜底；形状不对 / null / 404 一律兜底", () => {
    expect(parseAppConfig({ mode: "direct", fp: "ab12-cd34-ef56-7890", machineName: "mini", version: "1" }, fallback)).toMatchObject({ fp: "ab12-cd34-ef56-7890", machineName: "mini" });
    expect(parseAppConfig({ mode: "direct" }, fallback)).toMatchObject({ fp: "local", machineName: "here" });
    expect(parseAppConfig({ mode: "relay" }, fallback)).toBe(fallback);
    expect(parseAppConfig(null, fallback)).toBe(fallback);
    expect(parseAppConfig("garbage", fallback)).toBe(fallback);
  });
  test("基址：中继按机器 /m/<fp>，直托管是同源根", () => {
    expect(machineBase({ mode: "relay", relayBase: "r", version: "" }, "ab12-cd34-ef56-7890")).toBe("/m/ab12-cd34-ef56-7890");
    expect(machineBase(fallback, "whatever")).toBe("");
  });
});

describe("apiErrorFrom（非 2xx → 抛什么）", () => {
  test("401 一律是凭据失效：带 fp，code 取 bridge 的（没有就 device_invalid）", () => {
    const e = apiErrorFrom(401, { code: "device_invalid", error: "expired" }, "fp1");
    expect(e).toBeInstanceOf(DeviceInvalidError);
    expect((e as DeviceInvalidError).fp).toBe("fp1");
    expect(e.status).toBe(401);
    expect(apiErrorFrom(401, { error: "missing Authorization" }, "fp1").code).toBe("device_invalid");
  });
  test("其它 4xx 原样：message 取 error，body 带上（409 的 runId 前端要用）", () => {
    const e = apiErrorFrom(409, { ok: false, error: "already running", runId: "17" }, "fp1");
    expect(e).toBeInstanceOf(ApiError);
    expect(e).not.toBeInstanceOf(DeviceInvalidError);
    expect(e.status).toBe(409);
    expect(e.message).toBe("already running");
    expect(e.body.runId).toBe("17");
    expect(e.retryable).toBe(false);
  });
  test("可重试：503 或 body.retryable；非 JSON / 空体退回 HTTP <status>", () => {
    expect(apiErrorFrom(503, {}, "fp").retryable).toBe(true);
    expect(apiErrorFrom(502, { retryable: true }, "fp").retryable).toBe(true);
    expect(apiErrorFrom(502, "not json", "fp").message).toBe("HTTP 502");
    expect(apiErrorFrom(500, null, "fp").message).toBe("HTTP 500");
  });
});

describe("linkSignals（外部 signal / 超时接到请求 controller）", () => {
  test("已中止的直接传染；之后中止的也传染；undefined 跳过", () => {
    const pre = new AbortController();
    pre.abort("early");
    const c1 = new AbortController();
    linkSignals(c1, [undefined, pre.signal]);
    expect(c1.signal.aborted).toBe(true);
    expect(c1.signal.reason).toBe("early");

    const later = new AbortController();
    const c2 = new AbortController();
    linkSignals(c2, [later.signal]);
    expect(c2.signal.aborted).toBe(false);
    later.abort("late");
    expect(c2.signal.aborted).toBe(true);
    expect(c2.signal.reason).toBe("late");
  });
});

const rec = (fp: string, lastUsedAt: number, name = fp): MachineRecord => ({ fp, name, addedAt: 1, lastUsedAt });

describe("machines 纯逻辑", () => {
  test("upsert 覆盖同 fp；排序按最近使用降序、同刻按名字", () => {
    const list = upsertRecord([rec("a", 10), rec("b", 20)], rec("a", 30, "A2"));
    expect(list.map((m) => m.fp)).toEqual(["a", "b"]);
    expect(list[0].name).toBe("A2");
    expect(sortMachines([rec("y", 5), rec("x", 5)]).map((m) => m.fp)).toEqual(["x", "y"]);
  });
  test("pickCurrent：记住的还在就用；不在就最近的；空列表 null", () => {
    const list = [rec("a", 10), rec("b", 20)];
    expect(pickCurrent(list, "a")?.fp).toBe("a");
    expect(pickCurrent(list, "gone")?.fp).toBe("b");
    expect(pickCurrent([], "a")).toBeNull();
  });
});

describe("MachineStore（内存后端）", () => {
  test("add → 成为列表成员；setCurrent 通知切换监听（旧 fp → 新 fp）并刷新 lastUsedAt", async () => {
    const s = new MachineStore(memoryBackend());
    await s.load();
    expect(s.current()).toBeNull();
    await s.add({ fp: "a", name: "Mac A", lastUsedAt: 10 });
    await s.add({ fp: "b", name: "Mac B", principalId: "guest:1", lastUsedAt: 20 });
    expect(s.all().map((m) => m.fp)).toEqual(["b", "a"]);
    const switches: [string | null, string | null][] = [];
    s.onSwitch((p, n) => switches.push([p, n]));
    await s.setCurrent("a");
    await s.setCurrent("a"); // 同机器不算切换
    await s.setCurrent("b");
    expect(switches).toEqual([[null, "a"], ["a", "b"]]);
    expect(s.currentFp()).toBe("b");
    expect(s.get("b")?.principalId).toBe("guest:1");
  });
  test("markRepair 只标不删；remove 当前机器后退到下一台；load 从后端恢复当前机器", async () => {
    const backend = memoryBackend();
    const s = new MachineStore(backend);
    await s.load();
    await s.add({ fp: "a", name: "A" });
    await s.add({ fp: "b", name: "B" });
    await s.setCurrent("a");
    s.markRepair("a");
    expect(s.healthOf("a")).toBe("repair");
    expect(s.get("a")).toBeDefined();
    await s.remove("a");
    expect(s.currentFp()).toBe("b");
    const again = new MachineStore(backend);
    await again.load();
    expect(again.currentFp()).toBe("b");
    expect(again.all().map((m) => m.fp)).toEqual(["b"]);
  });
  test("add 覆盖同 fp 保留 addedAt，且清掉 repair 标记（刚配对成功）", async () => {
    const s = new MachineStore(memoryBackend());
    await s.load();
    const first = await s.add({ fp: "a", name: "A", addedAt: 5, lastUsedAt: 5 });
    s.markRepair("a");
    const second = await s.add({ fp: "a", name: "A renamed" });
    expect(second.addedAt).toBe(first.addedAt);
    expect(second.name).toBe("A renamed");
    expect(s.healthOf("a")).toBe("ok");
  });
});
