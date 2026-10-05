/**
 * RDC1 直连候选纯合同（src/lib/direct-candidate-contract.ts）：字段 / 身份 / 有效期 / URL 归属 / 缺 port / 重复 / 上限 / 模式 / 无副作用。
 * URL port 接的是既有纯谓词 address-predicates.ts（不在测试里另写 IP 判断）；签名 port 是假实现，只认登记过的证明串——
 * 真正的权威验签与候选发现由 RD2 接线，本卡不宣称直连路径可用。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isLoopbackAddress, isPrivateAddr, isTailscaleAddr } from "../src/lib/address-predicates.js";
import {
  decideDirectRoute, DIRECT_BUDGET_CEILING,
  type CandidateResult, type DirectBudget, type DirectDecision, type DirectDecisionInput, type DirectPorts, type DirectSource,
  type InstanceIdentity, type ProofVerdict, type UrlVerdict,
} from "../src/lib/direct-candidate-contract.js";

const NOW = 1_800_000_000_000;
const ME: InstanceIdentity = { fp: "16f9-b5d1-30fb-8923", iid: "a1b2c3d4e5f6a1b2c3d4e5f6" };
const OTHER: InstanceIdentity = { fp: "0000-1111-2222-3333", iid: "ffffffffffffffffffffffff" };
const BUDGET: DirectBudget = { maxCandidates: 4, maxTtlMs: 600_000, maxVerifyAgeMs: 60_000, maxSkewMs: 5_000 };

function cand(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "lan-1", source: "lan", instance: { ...ME }, url: "http://192.168.1.20:3847/",
    issuedAt: NOW - 10_000, expiresAt: NOW + 300_000, verifiedAt: NOW - 1_000,
    capabilities: ["peer"], proof: "sig:lan-1", ...over,
  };
}

/** 读 port：主机归属只经 address-predicates 的既有谓词；https 只认 ts.net 名字（示意 HTTPS 入口） */
function urlPortFromPredicates(calls: string[] = []): (url: string) => UrlVerdict {
  return (raw) => {
    calls.push(raw);
    const u = new URL(raw);
    const host = u.hostname;
    if (isLoopbackAddress(host)) return { ok: false, reason: "loopback" };
    if (u.protocol === "https:" && host.endsWith(".ts.net")) return { ok: true, source: "https" };
    if (isTailscaleAddr(host)) return { ok: true, source: "tailscale" };
    if (isPrivateAddr(host)) return { ok: true, source: "lan" };
    return { ok: false, reason: "not_owned" };
  };
}

/** 假签名 port：`sig:<id>` 视为该实例签过；其它都拒 */
function proofPort(signer: InstanceIdentity = ME, calls: string[] = []): DirectPorts["verifyProof"] {
  return (fact, proof): ProofVerdict => {
    calls.push(fact.id);
    return proof === `sig:${fact.id}` ? { ok: true, signer: { ...signer } } : { ok: false, reason: "bad_sig" };
  };
}

function ports(): DirectPorts {
  return { classifyUrl: urlPortFromPredicates(), verifyProof: proofPort() };
}

function input(candidates: unknown, over: Partial<DirectDecisionInput> = {}): DirectDecisionInput {
  return { mode: "on", expected: { ...ME }, need: "peer", candidates, now: NOW, budget: { ...BUDGET }, ...over };
}

const SOURCES: DirectSource[] = ["lan", "https", "tailscale"];

function only(d: DirectDecision): CandidateResult {
  expect(d.results).toHaveLength(1);
  return d.results[0]!;
}

function reasonFor(over: Record<string, unknown>, p: DirectPorts = ports(), extra: Partial<DirectDecisionInput> = {}): string | null {
  const r = only(decideDirectRoute(input([cand(over)], extra), p));
  return r.eligible ? null : r.reason;
}

describe("字段：输入不可信，错了给原因", () => {
  test("完整可核的合法候选才 eligible，on 下给出 direct 决策并保留中继兜底", () => {
    const d = decideDirectRoute(input([cand()]), ports());
    expect(only(d)).toEqual({ id: "lan-1", eligible: true, source: "lan", url: "http://192.168.1.20:3847/" });
    expect(d.route).toBe("direct");
    expect(d.pick).toEqual({ id: "lan-1", source: "lan", url: "http://192.168.1.20:3847/" });
    expect(d.relayFallback).toBe(true);
    expect(d.advisoryOnly).toBe(false);
    expect(d.listError).toBeNull();
  });

  test.each([
    ["id 非串", { id: 7 }, "bad_id"],
    ["id 空", { id: "" }, "bad_id"],
    ["id 带分隔符", { id: "a b" }, "bad_id"],
    ["id 超长", { id: "x".repeat(65) }, "bad_id"],
    ["来源不在白名单", { source: "rtc" }, "bad_source"],
    ["实例缺 iid", { instance: { fp: ME.fp } }, "bad_instance"],
    ["实例带多余字段", { instance: { ...ME, trusted: true } }, "bad_instance"],
    ["实例 fp 带空白", { instance: { ...ME, fp: "16f9 b5d1" } }, "bad_instance"],
    ["实例非对象", { instance: "me" }, "bad_instance"],
    ["URL 非串", { url: 1 }, "bad_url"],
    ["相对 URL", { url: "/api/v1" }, "bad_url"],
    ["非 http(s) 协议", { url: "ftp://192.168.1.20/" }, "bad_url"],
    ["URL 带凭据", { url: "http://u:p@192.168.1.20:3847/" }, "bad_url"],
    ["URL 带片段", { url: "http://192.168.1.20:3847/#x" }, "bad_url"],
    ["URL 超长", { url: `http://192.168.1.20/${"a".repeat(2100)}` }, "bad_url"],
    ["https 来源配 http URL", { source: "https", url: "http://mini.tail1.ts.net/" }, "bad_url"],
    ["签发时间非整数", { issuedAt: 1.5 }, "bad_time"],
    ["有效期是字符串", { expiresAt: String(NOW + 1) }, "bad_time"],
    ["验证时间 NaN", { verifiedAt: Number.NaN }, "bad_time"],
    ["到期不晚于签发", { expiresAt: NOW - 10_000 }, "bad_time"],
    ["能力为空", { capabilities: [] }, "bad_capabilities"],
    ["能力未知", { capabilities: ["shell"] }, "bad_capabilities"],
    ["能力重复", { capabilities: ["peer", "peer"] }, "bad_capabilities"],
    ["能力非数组", { capabilities: "peer" }, "bad_capabilities"],
  ])("%s → %s", (_n, over, reason) => {
    expect(reasonFor(over)).toBe(reason);
  });

  test("caller 自带的 trusted / verified 布尔不建立信任：未知字段整条拒", () => {
    expect(reasonFor({ trusted: true })).toBe("unknown_field");
    expect(reasonFor({ verified: true, proof: undefined })).toBe("unknown_field");
  });

  test("非普通对象、getter 字段、数组空洞都拒，且不触发 getter", () => {
    let touched = 0;
    const withGetter = cand();
    Object.defineProperty(withGetter, "url", { enumerable: true, get: () => (touched++, "http://192.168.1.20/") });
    const d = decideDirectRoute(input([withGetter, null, new Date(), Object.assign(Object.create({ x: 1 }), cand({ id: "p" }))]), ports());
    expect(d.results.map((r) => (r.eligible ? "ok" : r.reason))).toEqual(["bad_shape", "bad_shape", "bad_shape", "bad_shape"]);
    expect(touched).toBe(0);
    // eslint-disable-next-line no-sparse-arrays
    expect(decideDirectRoute(input([cand(), , cand({ id: "b" })]), ports()).results[1]).toEqual({ id: null, eligible: false, reason: "bad_shape" });
  });
});

describe("反射安全：只认自有数据字段，不可信访问器 / 代理不逃逸", () => {
  test("JSON 自有 __proto__ 键是未知字段，不能借原型把候选整个塞进来", () => {
    const smuggled = JSON.parse(JSON.stringify({ ["__proto__"]: cand() })) as unknown;
    expect(Object.getOwnPropertyNames(smuggled)).toEqual(["__proto__"]);
    const d = decideDirectRoute(input([smuggled]), ports());
    expect(only(d)).toEqual({ id: null, eligible: false, reason: "unknown_field" });
    expect(d.route).toBe("relay");
    expect(reasonFor({ ["__proto__"]: { trusted: true } })).toBe("unknown_field"); // 计算键 / 展开得到的自有 __proto__ 也是字段
    const viaJson = JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(cand()).slice(1)}`) as unknown;
    expect(only(decideDirectRoute(input([viaJson]), ports()))).toMatchObject({ eligible: false, reason: "unknown_field" });
  });

  test("嵌套身份 / port 判决里的 __proto__ 同样不算数", () => {
    const instance = JSON.parse(JSON.stringify({ ["__proto__"]: ME })) as unknown;
    expect(reasonFor({ instance })).toBe("bad_instance");
    const smuggledVerdict = JSON.parse(JSON.stringify({ ["__proto__"]: { ok: true, source: "lan" } })) as UrlVerdict;
    expect(reasonFor({}, { ...ports(), classifyUrl: () => smuggledVerdict })).toBe("url_port_bad_verdict");
  });

  test("能力数组下标 getter 不执行，给 bad_capabilities 而不是抛出", () => {
    let touched = 0;
    const caps: unknown[] = [];
    Object.defineProperty(caps, 0, { enumerable: true, get() { touched++; throw new Error("getter executed"); } });
    expect(reasonFor({ capabilities: caps })).toBe("bad_capabilities");
    expect(touched).toBe(0);
  });

  test("候选列表下标 getter 不执行，该条 bad_shape，其余照评", () => {
    let touched = 0;
    const list: unknown[] = [cand()];
    Object.defineProperty(list, 1, { enumerable: true, get() { touched++; return cand({ id: "b" }); } });
    const d = decideDirectRoute(input(list), ports());
    expect(d.results.map((r) => (r.eligible ? "ok" : r.reason))).toEqual(["ok", "bad_shape"]);
    expect(touched).toBe(0);
  });

  test("抛错 Proxy 作为候选 / 身份 / 能力 / 列表 / 判决都转成明确拒绝，异常不逃逸", () => {
    const hostile = (target: object = {}) => new Proxy(target, {
      getPrototypeOf() { throw new Error("hostile proxy"); },
      ownKeys() { throw new Error("hostile proxy"); },
      getOwnPropertyDescriptor() { throw new Error("hostile proxy"); },
      get() { throw new Error("hostile proxy"); },
    });
    expect(only(decideDirectRoute(input([hostile()]), ports()))).toEqual({ id: null, eligible: false, reason: "bad_shape" });
    expect(reasonFor({ instance: hostile() })).toBe("bad_instance");
    expect(reasonFor({ capabilities: hostile(["peer"]) })).toBe("bad_capabilities");
    expect(reasonFor({}, { ...ports(), classifyUrl: () => hostile() as UrlVerdict })).toBe("url_port_bad_verdict");
    expect(reasonFor({}, { ...ports(), verifyProof: () => hostile() as ProofVerdict })).toBe("proof_port_bad_verdict");
    expect(decideDirectRoute(input(hostile([cand()])), ports())).toMatchObject({ route: "relay", listError: "not_array", results: [] });
    const { proxy, revoke } = Proxy.revocable([cand()], {});
    revoke();
    expect(decideDirectRoute(input(proxy), ports())).toMatchObject({ route: "relay", listError: "not_array", results: [] });
    expect(decideDirectRoute(input([cand()], { budget: hostile() as DirectBudget }), ports())).toMatchObject({ listError: "bad_budget" });
    expect(decideDirectRoute(input([cand()], { expected: hostile() as InstanceIdentity }), ports())).toMatchObject({ listError: "bad_expected" });
  });

  test("代理列表每次读给不同值也只读一次：查重、评估、挑选用的是同一份快照", () => {
    let reads = 0;
    const list = new Proxy([cand()], {
      getOwnPropertyDescriptor(t, k) {
        if (k === "0") return { value: cand({ id: `v${reads++}`, proof: `sig:v${reads - 1}` }), writable: true, enumerable: true, configurable: true };
        return Reflect.getOwnPropertyDescriptor(t, k);
      },
    });
    const d = decideDirectRoute(input(list), ports());
    expect(reads).toBe(1);
    expect(d.pick).toEqual({ id: "v0", source: "lan", url: "http://192.168.1.20:3847/" });
  });
});

describe("身份与有效期", () => {
  test("候选声明的实例与期望对端不符 → identity_mismatch", () => {
    expect(reasonFor({ instance: { ...OTHER } })).toBe("identity_mismatch");
    expect(reasonFor({ instance: { fp: ME.fp, iid: OTHER.iid } })).toBe("identity_mismatch");
  });

  test("签名方与声明实例不符 → signer_mismatch（证明对、人不对）", () => {
    expect(reasonFor({}, { classifyUrl: urlPortFromPredicates(), verifyProof: proofPort(OTHER) })).toBe("signer_mismatch");
  });

  test("过期 / 未生效 / 有效期超预算 / 验证太旧 / 验证晚于现在都拒，边界时间可注入", () => {
    expect(reasonFor({ expiresAt: NOW })).toBe("expired");
    expect(reasonFor({ expiresAt: NOW + 1 })).toBeNull();
    expect(reasonFor({ issuedAt: NOW + BUDGET.maxSkewMs + 1, verifiedAt: NOW + BUDGET.maxSkewMs + 1, expiresAt: NOW + 60_000 })).toBe("not_yet_valid");
    expect(reasonFor({ issuedAt: NOW + BUDGET.maxSkewMs, verifiedAt: NOW + BUDGET.maxSkewMs, expiresAt: NOW + 60_000 })).toBeNull();
    expect(reasonFor({ issuedAt: NOW - 1, expiresAt: NOW - 1 + BUDGET.maxTtlMs + 1, verifiedAt: NOW - 1 })).toBe("ttl_too_long");
    expect(reasonFor({ issuedAt: NOW - 120_000, verifiedAt: NOW - BUDGET.maxVerifyAgeMs - 1 })).toBe("verify_stale");
    expect(reasonFor({ issuedAt: NOW - 120_000, verifiedAt: NOW - BUDGET.maxVerifyAgeMs })).toBeNull();
    expect(reasonFor({ verifiedAt: NOW + BUDGET.maxSkewMs + 1 })).toBe("bad_verified_at");
    expect(reasonFor({ verifiedAt: NOW - 20_000 })).toBe("bad_verified_at"); // 早于签发
    expect(reasonFor({}, ports(), { now: NOW + 400_000 })).toBe("expired");
  });

  test("缺所需能力 → capability_missing", () => {
    expect(reasonFor({ capabilities: ["tunnel"] })).toBe("capability_missing");
    expect(reasonFor({ capabilities: ["tunnel"] }, ports(), { need: "tunnel" })).toBeNull();
  });
});

describe("URL 归属：只经注入的既有 validator", () => {
  test.each([
    ["回环", { url: "http://127.0.0.1:3847/" }, "url_rejected"],
    ["公网地址", { url: "http://8.8.8.8:3847/" }, "url_rejected"],
    ["声明 lan 实为 tailscale 段", { url: "http://100.100.1.2:3847/" }, "source_mismatch"],
    ["声明 tailscale 实为 lan", { source: "tailscale" }, "source_mismatch"],
  ])("%s → %s", (_n, over, reason) => {
    expect(reasonFor(over)).toBe(reason);
  });

  test("validator 拒绝的原因原样带回（截断），对的来源都能过", () => {
    const r = only(decideDirectRoute(input([cand({ url: "http://8.8.8.8/" })]), ports()));
    expect(r).toEqual({ id: "lan-1", eligible: false, reason: "url_rejected", detail: "not_owned" });
    expect(reasonFor({ id: "t", source: "tailscale", url: "http://100.100.1.2:3847/", proof: "sig:t" })).toBeNull();
    expect(reasonFor({ id: "h", source: "https", url: "https://mini.tail1.ts.net/", proof: "sig:h" })).toBeNull();
  });

  test("port 交给 validator 的是规范化后的 href，非真 ok 的判决都不算数", () => {
    const seen: string[] = [];
    decideDirectRoute(input([cand({ url: "HTTP://192.168.1.20:3847" })]), { ...ports(), classifyUrl: urlPortFromPredicates(seen) });
    expect(seen).toEqual(["http://192.168.1.20:3847/"]);
    const truthy = (() => ({ ok: "yes", source: "lan" })) as unknown as DirectPorts["classifyUrl"];
    expect(reasonFor({}, { ...ports(), classifyUrl: truthy })).toBe("url_port_bad_verdict");
    expect(reasonFor({}, { ...ports(), classifyUrl: () => ({ ok: true, source: "rtc" as DirectSource }) })).toBe("url_port_bad_verdict");
    expect(reasonFor({}, { ...ports(), classifyUrl: () => { throw new Error("boom"); } })).toBe("url_port_error");
  });
});

describe("缺 port / 缺证明默认不可选", () => {
  test("没有 URL port、没有签名 port、没有证明各自给原因", () => {
    expect(reasonFor({}, { verifyProof: proofPort() })).toBe("url_port_missing");
    expect(reasonFor({}, { classifyUrl: urlPortFromPredicates() })).toBe("proof_port_missing");
    expect(reasonFor({}, {})).toBe("url_port_missing");
    expect(reasonFor({ proof: undefined })).toBe("proof_missing");
    const { proof: _drop, ...noProof } = cand();
    expect(only(decideDirectRoute(input([noProof]), ports()))).toMatchObject({ eligible: false, reason: "proof_missing" });
  });

  test("签名 port 拒、抛错、判决形状不对都不可选", () => {
    expect(reasonFor({ proof: "sig:someone-else" })).toBe("proof_rejected");
    expect(reasonFor({}, { ...ports(), verifyProof: () => { throw new Error("x"); } })).toBe("proof_port_error");
    const truthy = (() => ({ ok: 1, signer: ME })) as unknown as DirectPorts["verifyProof"];
    expect(reasonFor({}, { ...ports(), verifyProof: truthy })).toBe("proof_port_bad_verdict");
    expect(reasonFor({}, { ...ports(), verifyProof: () => ({ ok: true, signer: { fp: ME.fp } as InstanceIdentity }) })).toBe("proof_port_bad_verdict");
  });

  test("签名 port 看到的事实是冻结副本，改不动输入", () => {
    const raw = cand();
    let frozen = false;
    decideDirectRoute(input([raw]), {
      ...ports(),
      verifyProof: (fact, proof) => {
        frozen = Object.isFrozen(fact) && Object.isFrozen(fact.instance) && Object.isFrozen(fact.capabilities);
        expect("proof" in fact).toBe(false);
        expect(proof).toBe("sig:lan-1");
        return { ok: true, signer: { ...ME } };
      },
    });
    expect(frozen).toBe(true);
  });
});

describe("列表：非空、唯一、有上限", () => {
  test.each([
    ["非数组", { a: 1 }, "not_array"],
    ["空列表", [], "empty"],
    ["超过预算条数", Array.from({ length: BUDGET.maxCandidates + 1 }, (_, i) => cand({ id: `c${i}`, proof: `sig:c${i}` })), "too_many"],
    ["重复 id", [cand(), cand()], "duplicate_id"],
  ])("%s → %s，整单走中继、一个 port 都不调", (_n, list, err) => {
    const urlCalls: string[] = [];
    const proofCalls: string[] = [];
    const d = decideDirectRoute(input(list), { classifyUrl: urlPortFromPredicates(urlCalls), verifyProof: proofPort(ME, proofCalls) });
    expect(d).toMatchObject({ route: "relay", pick: null, listError: err, results: [], relayFallback: true });
    expect(urlCalls.length + proofCalls.length).toBe(0);
  });

  test("恰好到上限照常评估", () => {
    const list = Array.from({ length: BUDGET.maxCandidates }, (_, i) => cand({ id: `c${i}`, proof: `sig:c${i}` }));
    expect(decideDirectRoute(input(list), ports()).results.every((r) => r.eligible)).toBe(true);
  });

  test.each([
    ["条数为 0", { maxCandidates: 0 }],
    ["条数超天花板", { maxCandidates: DIRECT_BUDGET_CEILING.maxCandidates + 1 }],
    ["有效期非整数", { maxTtlMs: 1.5 }],
    ["验证时效超天花板", { maxVerifyAgeMs: DIRECT_BUDGET_CEILING.maxVerifyAgeMs + 1 }],
    ["偏差为负", { maxSkewMs: -1 }],
    ["缺字段", { maxTtlMs: undefined }],
  ])("预算必须显式且有界：%s → bad_budget", (_n, over) => {
    const d = decideDirectRoute(input([cand()], { budget: { ...BUDGET, ...over } as DirectBudget }), ports());
    expect(d).toMatchObject({ route: "relay", listError: "bad_budget", results: [] });
  });

  test.each([
    ["now 非整数", { now: Number.NaN }, "bad_now"],
    ["期望身份坏", { expected: { fp: "", iid: ME.iid } }, "bad_expected"],
    ["所需能力未知", { need: "shell" as never }, "bad_need"],
  ])("决策输入：%s → %s", (_n, over, err) => {
    expect(decideDirectRoute(input([cand()], over), ports())).toMatchObject({ route: "relay", listError: err, results: [] });
  });
});

describe("模式：off 无推荐，observe 只出结果，on 也只出决策", () => {
  test("off：不评估、不调 port、不推荐", () => {
    const calls: string[] = [];
    const d = decideDirectRoute(input([cand()], { mode: "off" }), { classifyUrl: urlPortFromPredicates(calls), verifyProof: proofPort(ME, calls) });
    expect(d).toEqual({ mode: "off", route: "relay", pick: null, advisoryOnly: false, relayFallback: true, listError: null, results: [] });
    expect(calls).toEqual([]);
  });

  test("observe：给建议但仍走中继，建议不是授权", () => {
    const d = decideDirectRoute(input([cand()], { mode: "observe" }), ports());
    expect(d.route).toBe("relay");
    expect(d.advisoryOnly).toBe(true);
    expect(d.pick?.id).toBe("lan-1");
    expect(only(d).eligible).toBe(true);
  });

  test("未知模式按 off 处理并报 bad_mode", () => {
    const d = decideDirectRoute(input([cand()], { mode: "auto" as never }), ports());
    expect(d).toMatchObject({ mode: "off", route: "relay", pick: null, listError: "bad_mode", results: [] });
  });

  test("on 下没有可选候选 → 走中继，逐条原因仍在", () => {
    const d = decideDirectRoute(input([cand({ proof: "nope" }), cand({ id: "b", expiresAt: NOW })]), ports());
    expect(d.route).toBe("relay");
    expect(d.pick).toBeNull();
    expect(d.results.map((r) => (r.eligible ? "ok" : r.reason))).toEqual(["proof_rejected", "expired"]);
  });

  test("多条可选时按 LAN → HTTPS → Tailscale，再按验证时间新、id 小，确定性挑选", () => {
    const ts = cand({ id: "t", source: "tailscale", url: "http://100.100.1.2:3847/", proof: "sig:t" });
    const https = cand({ id: "h", source: "https", url: "https://mini.tail1.ts.net/", proof: "sig:h" });
    const lanOld = cand({ id: "a", verifiedAt: NOW - 5_000, proof: "sig:a" });
    const lanNew = cand({ id: "z", verifiedAt: NOW - 100, proof: "sig:z" });
    const lanTie = cand({ id: "y", verifiedAt: NOW - 100, proof: "sig:y" });
    expect(decideDirectRoute(input([ts, https]), ports()).pick?.id).toBe("h");
    expect(decideDirectRoute(input([https, ts, lanOld]), ports()).pick?.id).toBe("a");
    expect(decideDirectRoute(input([lanOld, lanNew, lanTie]), ports()).pick?.id).toBe("y");
    expect(SOURCES).toEqual(["lan", "https", "tailscale"]);
  });
});

describe("纯函数：确定性、无副作用", () => {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  afterEach(() => {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  });

  test("同输入同输出，不读时钟、不发请求、不改输入", () => {
    let fetches = 0;
    let clock = 0;
    globalThis.fetch = (() => { fetches++; throw new Error("no network"); }) as unknown as typeof fetch;
    Date.now = () => (clock++, 0);
    const list = [cand(), cand({ id: "b", url: "http://8.8.8.8/" }), cand({ id: "c", expiresAt: NOW })];
    const snapshot = structuredClone(list);
    const a = decideDirectRoute(input(list), ports());
    const b = decideDirectRoute(input(list), ports());
    expect(a).toEqual(b);
    expect(list).toEqual(snapshot);
    expect(fetches).toBe(0);
    expect(clock).toBe(0);
  });

  test("port 只为过了本地检查的候选调用，且每条最多一次", () => {
    const urlCalls: string[] = [];
    const proofCalls: string[] = [];
    const list = [cand(), cand({ id: "b", expiresAt: NOW }), cand({ id: "c", url: "http://8.8.8.8/", proof: "sig:c" })];
    decideDirectRoute(input(list), { classifyUrl: urlPortFromPredicates(urlCalls), verifyProof: proofPort(ME, proofCalls) });
    expect(urlCalls).toEqual(["http://192.168.1.20:3847/", "http://8.8.8.8/"]);
    expect(proofCalls).toEqual(["lan-1"]);
  });

  test("模块是无 import 的叶子：不碰网卡 / DNS / 环境 / 本机配置 / 网络", () => {
    const src = readFileSync(join(import.meta.dir, "../src/lib/direct-candidate-contract.ts"), "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
    expect(src).not.toMatch(/process\.env|\bfetch\s*\(|Date\.now|new Date\b|Bun\./);
  });
});
