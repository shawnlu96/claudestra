/**
 * guest 默认一个 agent 都不开放（T42，owner 09-29）：签 guest 配对码必须写明 agents，不再隐式给 "*"；
 * 显式 "*" 要带 confirmAllAgents；自己的设备照旧默认全权。纯函数在 lib/devices.ts（checkGuestAgents），签码在 bridge/devices.ts。
 */
import { describe, expect, test } from "bun:test";
import { issuePairing } from "../src/bridge/devices.js";
import { pairNew } from "../src/bridge/relay-routes.js";
import { checkGuestAgents, OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { describeGrant, parsePairArgs } from "../src/manager/pair.js";
import type { Principal } from "../src/lib/principals.js";

const machine = { url: "https://mini.relay.test", base: "relay.test", slug: "mini", fp: "16f9-b5d1-30fb-8923" };
const owner: Principal = { id: OWNER_PRINCIPAL_ID, role: "owner", agents: ["*", "master"], terminal: true, createdAt: "", credential: "dev_owner" };

describe("checkGuestAgents", () => {
  test("没给、不是数组、空、只有空白：一律拒，报 guest_agents_required", () => {
    for (const input of [undefined, null, "worker-a", [], ["", "  "]]) {
      expect(checkGuestAgents(input, false)).toMatchObject({ ok: false, code: "guest_agents_required" });
    }
  });

  test("去掉大总管后没剩的也拒：master / agent-master 不能开放给 guest", () => {
    expect(checkGuestAgents(["master"], true)).toMatchObject({ ok: false, code: "guest_agents_required" });
    expect(checkGuestAgents(["agent-master", "master"], false)).toMatchObject({ ok: false, code: "guest_agents_required" });
  });

  test("具体 agent：去空去重、剔掉大总管，原样放行", () => {
    expect(checkGuestAgents([" worker-a ", "worker-b", "worker-a", "master"], false)).toEqual({ ok: true, agents: ["worker-a", "worker-b"] });
  });

  test('"*" 不带确认拒（guest_all_needs_confirm）；带确认放行且收成单个 "*"', () => {
    expect(checkGuestAgents(["*"], undefined)).toMatchObject({ ok: false, code: "guest_all_needs_confirm" });
    expect(checkGuestAgents(["*"], "true")).toMatchObject({ ok: false, code: "guest_all_needs_confirm" }); // 只认布尔 true
    expect(checkGuestAgents(["worker-a", "*"], false)).toMatchObject({ ok: false, code: "guest_all_needs_confirm" });
    expect(checkGuestAgents(["worker-a", "*", "master"], true)).toEqual({ ok: true, agents: ["*"] });
  });
});

describe("issuePairing：guest 码", () => {
  test("不带 agents / 空 agents：不签码，报错说要指定开放哪些 agent", () => {
    for (const body of [{ guest: "Alex" }, { guest: "Alex", agents: [] }, { guest: "Alex", agents: ["master"] }]) {
      const r = issuePairing(machine, body);
      expect(r).toMatchObject({ ok: false, code: "guest_agents_required" });
      expect(String(r.error)).toContain("guest 要指定开放哪些 agent");
    }
  });

  test("具体 agent：grant 只含这些，无终端、无管理（请求里给了也不算）", () => {
    const r = issuePairing(machine, { guest: "Alex", agents: ["worker-a", "master"], terminal: true, manage: true });
    expect(r).toMatchObject({ ok: true, guest: "Alex", grant: { agents: ["worker-a"], terminal: false, manage: false } });
  });

  test('显式 "*"：不确认拒；确认后签出 "*"（不含大总管）', () => {
    expect(issuePairing(machine, { guest: "Alex", agents: ["*"] })).toMatchObject({ ok: false, code: "guest_all_needs_confirm" });
    const r = issuePairing(machine, { guest: "Alex", agents: ["*"], confirmAllAgents: true });
    expect(r).toMatchObject({ ok: true, grant: { agents: ["*"], terminal: false, manage: false } });
  });

  test('网页发码（有 issuer）同样要写明；"*" 确认后按发码设备自己的范围封顶', () => {
    expect(issuePairing(machine, { guest: "Alex" }, owner)).toMatchObject({ ok: false, code: "guest_agents_required" });
    const narrow: Principal = { ...owner, role: "external", agents: ["worker-a", "worker-b"], manage: true, credential: "dev_n" };
    expect(issuePairing(machine, { guest: "Alex", agents: ["*"], confirmAllAgents: true }, narrow)).toMatchObject({
      ok: true, grant: { agents: ["worker-a", "worker-b"], terminal: false, manage: false },
    });
  });

  test("自己的设备不受影响：不带 agents 仍是全权", () => {
    expect(issuePairing(machine, {})).toMatchObject({ ok: true, grant: { agents: ["*", "master"], terminal: true, manage: true } });
  });
});

describe("POST /relay/pair/new 与 /api/v1/relay/pair 的状态码", () => {
  const post = (body: unknown, issuer?: Principal) =>
    pairNew(new Request("http://bridge.local/relay/pair/new", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), issuer);

  test("guest 校验失败回 400（不是 403 / 500），body 带 code", async () => {
    for (const issuer of [undefined, owner]) {
      const res = await post({ guest: "Alex" }, issuer);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, code: "guest_agents_required" });
    }
    const all = await post({ guest: "Alex", agents: ["*"] });
    expect(all.status).toBe(400);
    expect(await all.json()).toMatchObject({ code: "guest_all_needs_confirm" });
  });
});

describe("CLI：claudestra pair 的参数校验（本地判错，不打 bridge）", () => {
  test("--guest 不带 --agents / 只给大总管：报错并给示例", () => {
    for (const args of [["--guest", "Alex"], ["--guest", "Alex", "--agents", "master"], ["--guest", "Alex", "--agents", " , "]]) {
      const r = parsePairArgs(args);
      expect(r.error).toContain("--guest 要用 --agents 写明开放哪些 agent");
      expect(r.error).toContain("例：claudestra pair --guest");
    }
  });

  test("--guest 后面没写名字：报错，不会退化成给自己签全权码", () => {
    expect(parsePairArgs(["--guest"]).error).toContain("--guest 后面要写");
    expect(parsePairArgs(["--guest", "--agents", "worker-a"]).error).toContain("--guest 后面要写");
  });

  test("--guest + 具体 agent：body 原样带过去，不需要确认", () => {
    const r = parsePairArgs(["--guest", "Alex", "--agents", "worker-a, worker-b"]);
    expect(r).toMatchObject({ body: { guest: "Alex", agents: ["worker-a", "worker-b"] }, needsAllConfirm: false });
    expect(r.error).toBeUndefined();
    expect(r.body.confirmAllAgents).toBeUndefined();
  });

  test("--guest --agents '*'：要确认；加 --confirm-all 就直接带 confirmAllAgents", () => {
    expect(parsePairArgs(["--guest", "Alex", "--agents", "*"])).toMatchObject({ needsAllConfirm: true });
    expect(parsePairArgs(["--guest", "Alex", "--agents", "*", "--confirm-all"])).toMatchObject({ needsAllConfirm: false, body: { confirmAllAgents: true } });
  });

  test("不带 --guest：照旧（自己的设备，--confirm-all 不进 body）", () => {
    expect(parsePairArgs([])).toMatchObject({ body: {}, json: false });
    expect(parsePairArgs(["--agents", "worker-a", "--confirm-all", "--json"])).toEqual({ body: { agents: ["worker-a"] }, json: true });
  });

  test("describeGrant 把开放的 agent 逐个列清楚；'*' 写明是全部非大总管、以后新建的也算", () => {
    const g = { terminal: false, manage: false };
    expect(describeGrant({ ...g, agents: ["gc-car", "relay"] }, "Alex")).toBe("给「Alex」的设备（独立身份）：2 个 agent：gc-car、relay；终端 关；管理 关");
    expect(describeGrant({ ...g, agents: ["*"] }, "Alex")).toContain("全部非大总管 agent（以后新建的也算）");
    expect(describeGrant({ agents: ["*", "master"], terminal: true, manage: true })).toBe("你自己的设备：全部 agent（含大总管，以后新建的也算）；终端 开；管理 开");
    expect(describeGrant({ ...g, agents: ["worker-a", "master"] })).toContain("2 个 agent：worker-a、大总管");
  });
});
