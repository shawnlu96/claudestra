/**
 * guest 默认一个 agent 都不开放（T42，owner 09-29）：签 guest 配对码必须写明 agents，不再隐式给 "*"；
 * 显式 "*" 要带 confirmAllAgents；自己的设备照旧默认全权。纯函数在 lib/devices.ts（checkGuestAgents），签码在 bridge/devices.ts。
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issuePairing, setDevicesRegistryPathForTest } from "../src/bridge/devices.js";
import { pairNew } from "../src/bridge/relay-routes.js";
import { checkGuestAgents, OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { cmdPair, describeGrant, parsePairArgs } from "../src/manager/pair.js";
import type { Principal } from "../src/lib/principals.js";

const machine = { url: "https://mini.relay.test", base: "relay.test", slug: "mini", fp: "16f9-b5d1-30fb-8923" };
const owner: Principal = { id: OWNER_PRINCIPAL_ID, role: "owner", agents: ["*", "master"], terminal: true, createdAt: "", credential: "dev_owner" };
/** registry 里有的 agent（键带 agent- 前缀，与生产一致） */
const REG = ["agent-worker-a", "agent-worker-b", "agent-cc"];
const has = (n: string) => REG.includes(n) || REG.includes(`agent-${n}`);

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "guest-pairing-"));
  writeFileSync(join(dir, "registry.json"), JSON.stringify({ agents: Object.fromEntries(REG.map((n) => [n, {}])) }));
  setDevicesRegistryPathForTest(join(dir, "registry.json"));
});
afterAll(() => {
  setDevicesRegistryPathForTest(undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe("checkGuestAgents", () => {
  test("没给、不是数组、空、只有空白：一律拒，报 guest_agents_required", () => {
    for (const input of [undefined, null, "worker-a", [], ["", "  "]]) {
      expect(checkGuestAgents(input, false, has)).toMatchObject({ ok: false, code: "guest_agents_required" });
    }
  });

  test("去掉大总管后没剩的也拒：master / agent-master 不能开放给 guest", () => {
    expect(checkGuestAgents(["master"], true, has)).toMatchObject({ ok: false, code: "guest_agents_required" });
    expect(checkGuestAgents(["agent-master", "master"], false, has)).toMatchObject({ ok: false, code: "guest_agents_required" });
  });

  test("具体 agent：去空去重、剔掉大总管，原样放行", () => {
    expect(checkGuestAgents([" worker-a ", "worker-b", "worker-a", "master"], false, has)).toEqual({ ok: true, agents: ["worker-a", "worker-b"] });
  });

  test("名字先规范化（NFKC、去零宽、转小写）再校验、按规范形式存：大小写 / 全角变体认成同一个 agent", () => {
    expect(checkGuestAgents(["CC", "Agent-Worker-A", "\uff43\uff43", "w\u200borker-b"], false, has)).toEqual({ ok: true, agents: ["cc", "agent-worker-a", "worker-b"] });
  });

  test("大总管的任何变体都剔掉：MASTER、Agent-Master、全角、夹零宽字符；只剩它们就当没写", () => {
    for (const name of ["MASTER", "Master", "agent-MASTER", "Agent-Master", "\uff4daster", "master\u200b", "\u200bagent-master"]) {
      expect(checkGuestAgents([name], true, has)).toMatchObject({ ok: false, code: "guest_agents_required" });
      expect(checkGuestAgents([name, "cc"], false, has)).toEqual({ ok: true, agents: ["cc"] });
    }
  });

  test('带 * 的名字（除了恰好 "*"）拒：**、agent-*、ma*；全角 ＊ 与夹零宽的 * 规范化后就是 "*"，要确认', () => {
    for (const name of ["**", "agent-*", "ma*", "*cc"]) expect(checkGuestAgents([name], true, has)).toMatchObject({ ok: false, code: "guest_agent_wildcard" });
    for (const name of ["\uff0a", "*\u200b", " * "]) {
      expect(checkGuestAgents([name], false, has)).toMatchObject({ ok: false, code: "guest_all_needs_confirm" });
      expect(checkGuestAgents([name], true, has)).toEqual({ ok: true, agents: ["*"] });
    }
  });

  test("registry 里没有的名字拒（guest_agent_unknown）：不能预先授权以后才建的同名 agent", () => {
    for (const input of [["nope-xyz"], ["cc", "nope-xyz"], ["*", "nope-xyz"]]) expect(checkGuestAgents(input, true, has)).toMatchObject({ ok: false, code: "guest_agent_unknown" });
    expect(checkGuestAgents(["cc", "agent-worker-a"], false, has)).toEqual({ ok: true, agents: ["cc", "agent-worker-a"] }); // 裸名、带前缀都认
  });

  test('"*" 不带确认拒（guest_all_needs_confirm）；带确认放行且收成单个 "*"', () => {
    expect(checkGuestAgents(["*"], undefined, has)).toMatchObject({ ok: false, code: "guest_all_needs_confirm" });
    expect(checkGuestAgents(["*"], "true", has)).toMatchObject({ ok: false, code: "guest_all_needs_confirm" }); // 只认布尔 true
    expect(checkGuestAgents(["worker-a", "*"], false, has)).toMatchObject({ ok: false, code: "guest_all_needs_confirm" });
    expect(checkGuestAgents(["worker-a", "*", "master"], true, has)).toEqual({ ok: true, agents: ["*"] });
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

  test("开放的名字：registry 里没有 / 带通配 / 只有大总管变体都不签；大小写变体按规范名签，网页发码也一样", () => {
    for (const issuer of [undefined, owner]) {
      expect(issuePairing(machine, { guest: "Alex", agents: ["nope-xyz"] }, issuer)).toMatchObject({ ok: false, code: "guest_agent_unknown" });
      expect(issuePairing(machine, { guest: "Alex", agents: ["agent-*"] }, issuer)).toMatchObject({ ok: false, code: "guest_agent_wildcard" });
      expect(issuePairing(machine, { guest: "Alex", agents: ["MASTER", "\uff4daster"] }, issuer)).toMatchObject({ ok: false, code: "guest_agents_required" });
      expect(issuePairing(machine, { guest: "Alex", agents: ["CC"] }, issuer)).toMatchObject({ ok: true, grant: { agents: ["cc"] } });
    }
  });

  test("带了 guest 字段但名字是空白 / 数字 / null：拒（guest_name_required），不会退化成给自己签全权码", () => {
    for (const guest of ["", "   ", 123, null, false, ["Alex"]]) {
      for (const issuer of [undefined, owner]) {
        const r = issuePairing(machine, { guest, agents: ["worker-a"] }, issuer);
        expect(r).toMatchObject({ ok: false, code: "guest_name_required" });
        expect(r.grant).toBeUndefined();
      }
    }
    expect(issuePairing(machine, { guest: "123", agents: ["worker-a"] })).toMatchObject({ ok: true, guest: "123", grant: { manage: false } }); // 文字的数字名照常
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
    const blank = await post({ guest: "  ", agents: ["worker-a"] }, owner);
    expect(blank.status).toBe(400);
    expect(await blank.json()).toMatchObject({ code: "guest_name_required" });
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
    expect(parsePairArgs(["--guest", "   ", "--agents", "worker-a"]).error).toContain("--guest 后面要写");
    expect(parsePairArgs(["--guest", " Alex ", "--agents", "worker-a"]).body.guest).toBe("Alex");
  });

  test("--x=v 写法照认：--guest=Alex 是 guest 码，不会变成给自己签全权码", () => {
    expect(parsePairArgs(["--guest=Alex", "--agents=worker-a,cc"])).toMatchObject({ body: { guest: "Alex", agents: ["worker-a", "cc"] }, needsAllConfirm: false });
    expect(parsePairArgs(["--guest=Alex"]).error).toContain("--guest 要用 --agents 写明");
    expect(parsePairArgs(["--guest=", "--agents", "cc"]).error).toContain("--guest 后面要写");
    expect(parsePairArgs(["--guest=Alex", "--agents=*", "--url=https://x.test"])).toMatchObject({ body: { url: "https://x.test" }, needsAllConfirm: true });
  });

  test("不认识的旗标、多出来的词、缺值的旗标：直接报错（--Guest 打错大小写不能悄悄签全权码）", () => {
    for (const args of [["--Guest", "Alex"], ["--GUEST=Alex"], ["--guests", "Alex"], ["-g", "Alex"], ["Alex"], ["--guest", "Alex", "--agents", "cc", "extra"], ["--json=1"]]) {
      expect(parsePairArgs(args).error).toContain("不认识的参数");
    }
    expect(parsePairArgs(["--agents"]).error).toContain("--agents 后面要跟值");
    expect(parsePairArgs(["--url", "--json"]).error).toContain("--url 后面要跟值");
  });

  test("本地判错、没确认的 '*'：退出码 1（不打 bridge），脚本不用解析 JSON 也知道没签成", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const args of [["--guest"], ["--guest", "Alex"], ["--Guest", "Alex"], ["--guest", "Alex", "--agents", "*", "--json"]]) {
        process.exitCode = 0;
        await cmdPair(args);
        expect(process.exitCode).toBe(1);
        expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ ok: false });
      }
    } finally {
      process.exitCode = 0;
      log.mockRestore();
    }
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
