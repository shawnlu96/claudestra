/**
 * 设备凭据（src/lib/devices.ts）：签发 / 查找 / 收窄 / 滑动过期 / cookie / CSRF / 挑战 / 待确认队列 / 管理门。
 */
import { describe, expect, test } from "bun:test";
import {
  Approvals, ChallengeStore, attachCredential, canManage, cookieValueFrom, csrfOk, deviceCookieHeader, effectivePrincipal, ensureOwnerPrincipal,
  findCredential, fullGrant, guestGrant, hashDeviceToken, intersectAgents, newGuestPrincipal, normalizeGrant, OWNER_PRINCIPAL_ID, touchCredential,
} from "../src/lib/devices.js";
import type { Principal, PrincipalsFile } from "../src/lib/principals.js";

const T0 = new Date("2026-09-27T12:00:00Z");
let seed = 1;
/** 每次调用换一组字节：同一测试里连签两条不能撞 id / 挑战 */
const random = (n: number) => (seed++, new Uint8Array(n).map((_, i) => (seed * 31 + i * 7) % 256));
const fresh = (): PrincipalsFile => ({ principals: [] });

describe("owner principal 与凭据", () => {
  test("第一次配对建 owner:self（role owner、全 agent + master、终端、镜像）；再来不重复", () => {
    const file = fresh();
    const p = ensureOwnerPrincipal(file, T0);
    expect(p).toMatchObject({ id: OWNER_PRINCIPAL_ID, role: "owner", agents: ["*", "master"], terminal: true, mirror: true, credentials: [] });
    expect(ensureOwnerPrincipal(file, T0)).toBe(p);
    expect(file.principals).toHaveLength(1);
  });
  test("签发：明文只回一次，落盘的是 sha256；能按 token 找回；名字截 64", () => {
    const file = fresh();
    const p = ensureOwnerPrincipal(file, T0);
    seed = 2;
    const { token, credential } = attachCredential(p, " iPhone ".padEnd(80, "x"), fullGrant(), { now: T0, ip: "203.0.113.9", random });
    expect(token.startsWith("dev_")).toBe(true);
    expect(credential.hash).toBe(hashDeviceToken(token));
    expect(credential).toMatchObject({ v: 1, type: "bearer", lastIp: "203.0.113.9", expiresAt: "2026-12-26T12:00:00.000Z" });
    expect(credential.deviceName).toHaveLength(64);
    expect(JSON.stringify(file)).not.toContain(token);
    expect(findCredential(file, token, T0)).toMatchObject({ principal: { id: OWNER_PRINCIPAL_ID }, credential: { id: credential.id } });
  });
  test("找不到：不是 dev_ 前缀、禁用、过期、principal 禁用、哈希不同", () => {
    const file = fresh();
    const p = ensureOwnerPrincipal(file, T0);
    const { token, credential } = attachCredential(p, "a", fullGrant(), { now: T0, random });
    expect(findCredential(file, "tok_" + token.slice(4), T0)).toBeNull();
    expect(findCredential(file, token + "x", T0)).toBeNull();
    expect(findCredential(file, token, new Date(Date.parse(credential.expiresAt) + 1))).toBeNull();
    credential.disabled = true;
    expect(findCredential(file, token, T0)).toBeNull();
    credential.disabled = false;
    p.disabled = true;
    expect(findCredential(file, token, T0)).toBeNull();
  });
  test("touch：10 分钟内不落盘；超过就更新 lastSeen 并把到期往后滑；IP 变了也落盘", () => {
    const c = attachCredential(ensureOwnerPrincipal(fresh(), T0), "a", fullGrant(), { now: T0, random }).credential;
    expect(touchCredential(c, new Date(T0.getTime() + 60_000), null)).toBe(true); // 第一次没有 lastSeenAt
    expect(touchCredential(c, new Date(T0.getTime() + 120_000), null)).toBe(false);
    expect(touchCredential(c, new Date(T0.getTime() + 120_000), "10.0.0.2")).toBe(true);
    const later = new Date(T0.getTime() + 30 * 24 * 3600_000);
    expect(touchCredential(c, later, "10.0.0.2")).toBe(true);
    expect(c.expiresAt).toBe(new Date(later.getTime() + 90 * 24 * 3600_000).toISOString());
  });
});

describe("grant 与生效视图", () => {
  test("normalizeGrant：缺省补全、去空去重、非法类型忽略；guestGrant 不含 master 不开终端", () => {
    expect(normalizeGrant(undefined)).toEqual(fullGrant());
    expect(normalizeGrant({ agents: ["a", " a ", "", "b"], terminal: false, manage: "yes" })).toEqual({ agents: ["a", "b"], terminal: false, manage: true });
    expect(normalizeGrant({ agents: [] })).toEqual(fullGrant());
    expect(guestGrant(["master", "x"])).toEqual({ agents: ["x"], terminal: false, manage: false });
  });
  test("intersectAgents：* 与 master 各自要两边都有；具名 agent 要在 principal 范围内", () => {
    expect(intersectAgents(["*", "master"], ["*", "master"])).toEqual(["*", "master"]);
    expect(intersectAgents(["*", "master"], ["*"])).toEqual(["*"]);
    expect(intersectAgents(["*", "master"], ["a", "master"])).toEqual(["master", "a"].sort());
    expect(intersectAgents(["a", "b"], ["*"])).toEqual(["a", "b"]);
    expect(intersectAgents(["a"], ["b", "master"])).toEqual([]);
  });
  test("agent-master 别名也是大总管：guest 剔掉、收窄时不能借 \"*\" 混进来（codex 复核）", () => {
    expect(guestGrant(["agent-master", "x"]).agents).toEqual(["x"]);
    expect(newGuestPrincipal("friend", { agents: ["agent-master", "master", "x"], terminal: false, manage: false }, T0).agents).toEqual(["x"]);
    expect(intersectAgents(["*"], ["agent-master", "a"])).toEqual(["a"]);
    expect(intersectAgents(["*", "master"], ["agent-master"])).toEqual(["master"]);
    expect(intersectAgents(["agent-master", "a"], ["*"])).toEqual(["a"]);
  });
  test("effectivePrincipal：id / mirror 不变；终端关则 role 降 external；manage 跟 grant；canManage 据此判", () => {
    const file = fresh();
    const owner = ensureOwnerPrincipal(file, T0);
    const full = attachCredential(owner, "mac", fullGrant(), { now: T0, random });
    const limited = attachCredential(owner, "kid", { agents: ["a"], terminal: false, manage: false }, { now: T0, random });
    const e1 = effectivePrincipal({ principal: owner, credential: full.credential });
    expect(e1).toMatchObject({ id: OWNER_PRINCIPAL_ID, role: "owner", agents: ["*", "master"], terminal: true, manage: true, credential: full.credential.id, mirror: true });
    expect(canManage(e1)).toBe(true);
    const e2 = effectivePrincipal({ principal: owner, credential: limited.credential });
    expect(e2).toMatchObject({ id: OWNER_PRINCIPAL_ID, role: "external", agents: ["a"], terminal: false, manage: false });
    expect(canManage(e2)).toBe(false);
  });
  test("canManage：owner 放；老的全 scope 非 peer token 过渡期放；peer 一律拒；具名 scope 拒", () => {
    const base = { name: "t", createdAt: "x" };
    expect(canManage({ ...base, id: "token:a", role: "external", agents: ["*", "master"] } as Principal)).toBe(true);
    expect(canManage({ ...base, id: "token:b", role: "external", agents: ["*"], peer: "Sekai" } as Principal)).toBe(false);
    expect(canManage({ ...base, id: "token:c", role: "external", agents: ["x"] } as Principal)).toBe(false);
    expect(canManage({ ...base, id: "discord:1", role: "owner", agents: ["*", "master"] } as Principal)).toBe(true);
  });
  test("guest principal：独立 id、external、不含 master、终端按 grant", () => {
    const g = newGuestPrincipal("Alice", { agents: ["a", "master"], terminal: true, manage: false }, T0, random);
    expect(g).toMatchObject({ role: "external", name: "Alice", agents: ["a"], terminal: true, credentials: [] });
    expect(g.id.startsWith("guest:")).toBe(true);
  });
});

describe("cookie 与 CSRF", () => {
  test("cookieValueFrom 取第一个匹配；deviceCookieHeader 签发 / 删除；回环不带 Secure", () => {
    expect(cookieValueFrom("a=1; cstra_dev=dev_x; b=2")).toBe("dev_x");
    expect(cookieValueFrom("a=1")).toBeNull();
    expect(cookieValueFrom(null)).toBeNull();
    expect(deviceCookieHeader("dev_x", { secure: true })).toBe("cstra_dev=dev_x; Path=/; Max-Age=7776000; HttpOnly; SameSite=Strict; Secure");
    expect(deviceCookieHeader(null, { secure: false, path: "/m/x" })).toBe("cstra_dev=; Path=/m/x; Max-Age=0; HttpOnly; SameSite=Strict");
  });
  test("csrfOk：GET/HEAD 不要头；其余必须带", () => {
    expect(csrfOk("GET", null)).toBe(true);
    expect(csrfOk("head", null)).toBe(true);
    expect(csrfOk("POST", null)).toBe(false);
    expect(csrfOk("POST", "1")).toBe(true);
  });
});

describe("ChallengeStore / Approvals", () => {
  test("挑战一次性、过期不认、超过上限顶掉最旧", () => {
    let now = T0.getTime();
    const s = new ChallengeStore(() => now, random, 2, 1000);
    const a = s.issue().challenge, b = s.issue().challenge;
    const c = s.issue().challenge; // a 被顶掉
    expect(s.consume(a)).toBe(false);
    expect(s.consume(b)).toBe(true);
    expect(s.consume(b)).toBe(false);
    now += 1001;
    expect(s.consume(c)).toBe(false);
  });
  test("待确认：pending → 批准带结果 → 浏览器取走一次即删；拒绝 / 过期 / 未知都有明确状态", () => {
    let now = T0.getTime();
    const q = new Approvals(() => now, random, 1000);
    const a = q.add({ code: "ABCD2345", deviceName: "iPhone", clientIp: "1.2.3.4", grant: fullGrant() });
    expect(q.pending().map((x) => x.id)).toEqual([a.id]);
    expect(q.take(a.id)).toEqual({ state: "pending" });
    expect(q.decide(a.id, true, { token: "dev_t", credentialId: "dev_1", principalId: OWNER_PRINCIPAL_ID, expiresAt: "2027-01-01T00:00:00.000Z" })).toMatchObject({ state: "approved" });
    expect(q.decide(a.id, false)).toBeNull(); // 已决定
    expect(q.take(a.id)).toMatchObject({ state: "approved", result: { token: "dev_t" } });
    expect(q.take(a.id)).toEqual({ state: "expired" }); // 拿过就没了
    const d = q.add({ code: "X", deviceName: "y", clientIp: null, grant: fullGrant() });
    q.decide(d.id, false);
    expect(q.take(d.id)).toEqual({ state: "denied" });
    const e = q.add({ code: "Z", deviceName: "z", clientIp: null, grant: fullGrant() });
    now += 1001;
    expect(q.pending()).toEqual([]);
    expect(q.take(e.id)).toEqual({ state: "expired" });
  });
});
