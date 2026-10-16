/**
 * /api/v1 限速桶（src/lib/api-rate-bucket.ts，bridge/api-auth.ts 调）：owner 所有设备共用一个 600 的桶，
 * 与先到的是受限设备还是满权设备无关；旧桶容量不对就地调整、不清零；peer / 普通 token 不变；429 每桶每分钟一行日志、不泄露凭据。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authenticateApi, setApiAuthPrincipalsPathForTest } from "../src/bridge/api-auth.js";
import { setRequestContext } from "../src/bridge/request-context.js";
import { ApiRateBucket, apiRateBucket, createApiRateLimiter, routeTemplate } from "../src/lib/api-rate-bucket.js";
import { attachCredential, DEVICE_COOKIE, effectivePrincipal, ensureOwnerPrincipal, fullGrant } from "../src/lib/devices.js";
import { newTokenPrincipal, type Principal, type PrincipalsFile } from "../src/lib/principals.js";

const restricted = () => ({ agents: ["*"], terminal: false, manage: false });

function ownerViews() {
  const file = { version: 1, principals: [] } as unknown as PrincipalsFile;
  const owner = ensureOwnerPrincipal(file);
  const full = attachCredential(owner, "Mac", fullGrant());
  const limited = attachCredential(owner, "headless", restricted());
  const cred = (id: string) => owner.credentials!.find((c) => c.id === id)!;
  return {
    owner,
    full: effectivePrincipal({ principal: owner, credential: cred(full.credential.id) }),
    limited: effectivePrincipal({ principal: owner, credential: cred(limited.credential.id) }),
    tokens: [full.token, limited.token],
  };
}

function exhaust(charge: () => { limit: number } | null, max = 2_000): { passed: number; limit: number | null } {
  let passed = 0;
  for (let i = 0; i < max; i++) {
    const r = charge();
    if (r) return { passed, limit: r.limit };
    passed++;
  }
  return { passed, limit: null };
}

describe("[验收线 1] 受限 owner 设备先到、满权设备后到", () => {
  test("共用 owner 桶，容量 600，第 601 次被拒，文案写 600", () => {
    const { full, limited } = ownerViews();
    expect(limited.role).toBe("external"); // 前提：受限设备的生效视图已降级
    expect(apiRateBucket(limited)).toEqual(apiRateBucket(full));
    expect(apiRateBucket(limited).limit).toBe(600);
    const rl = createApiRateLimiter(() => {});
    const now = 1_000_000;
    expect(rl.charge(limited, "/api/v1/agents", now)).toBeNull();
    const r = exhaust(() => rl.charge(full, "/api/v1/agents", now));
    expect(r).toEqual({ passed: 599, limit: 600 });
    expect(rl.buckets.size).toBe(1);
  });

  test("经 authenticateApi：受限设备先、满权设备后，第 601 次 429 文案写 600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ratebucket-"));
    try {
      const file = { version: 1, principals: [] } as unknown as PrincipalsFile;
      const owner = ensureOwnerPrincipal(file);
      const fullTok = attachCredential(owner, "Mac", fullGrant()).token;
      const limitedTok = attachCredential(owner, "headless", restricted()).token;
      writeFileSync(join(dir, "principals.json"), JSON.stringify(file));
      setApiAuthPrincipalsPathForTest(join(dir, "principals.json"));
      const call = async (tok: string) => {
        const r = new Request("http://bridge.local/api/v1/agents", { headers: { cookie: `${DEVICE_COOKIE}=${tok}` } });
        setRequestContext(r, { source: "lan", clientIp: "192.168.1.9", https: false });
        return authenticateApi(r, new URL(r.url), { rateLimit: true });
      };
      expect(await call(limitedTok)).not.toBeInstanceOf(Response);
      let passed = 1;
      let res: Response | null = null;
      for (let i = 0; i < 700 && !res; i++) {
        const out = await call(fullTok);
        if (out instanceof Response) res = out;
        else passed++;
      }
      expect(res?.status).toBe(429);
      expect(passed).toBe(600);
      expect(((await res!.json()) as { error: string }).error).toBe("rate limit exceeded (600 req/min)");
    } finally {
      setApiAuthPrincipalsPathForTest(undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[验收线 2] 满权设备先到、受限设备后到", () => {
  test("结果同上：600，第 601 次被拒", () => {
    const { full, limited } = ownerViews();
    const rl = createApiRateLimiter(() => {});
    const now = 1_000_000;
    expect(rl.charge(full, "/api/v1/agents", now)).toBeNull();
    expect(exhaust(() => rl.charge(limited, "/api/v1/agents", now))).toEqual({ passed: 599, limit: 600 });
  });

  test("旧桶被锁在 120：下一次请求调成 600，窗口内已计次数保留", () => {
    const { limited } = ownerViews();
    const rl = createApiRateLimiter(() => {});
    const now = 1_000_000;
    const old = new ApiRateBucket(120);
    for (let i = 0; i < 120; i++) expect(old.tryAcquire(now)).toBe(true);
    rl.buckets.set(apiRateBucket(limited).key, old);
    expect(rl.charge(limited, "/api/v1/agents", now + 1)).toBeNull();
    expect(rl.buckets.get(apiRateBucket(limited).key)).toBe(old);
    expect(old.limit).toBe(600);
    expect(old.used(now + 1)).toBe(121);
    expect(exhaust(() => rl.charge(limited, "/api/v1/agents", now + 1))).toEqual({ passed: 479, limit: 600 });
  });
});

describe("[验收线 3] peer token、普通 token 不变", () => {
  test("key = tokenIdOf，容量 120；owner 角色的 token 仍是 600", () => {
    const peer = newTokenPrincipal("peer-x", ["*"], { peer: "x" });
    const script = newTokenPrincipal("script", ["*"]);
    const ownerTok: Principal = { ...newTokenPrincipal("admin", ["*"]), role: "owner" };
    expect(apiRateBucket(peer)).toEqual({ key: peer.id.slice(6), limit: 120 });
    expect(apiRateBucket(script)).toEqual({ key: script.id.slice(6), limit: 120 });
    expect(apiRateBucket(ownerTok)).toEqual({ key: ownerTok.id.slice(6), limit: 600 });
    const rl = createApiRateLimiter(() => {});
    expect(exhaust(() => rl.charge(script, "/api/v1/agents", 5))).toEqual({ passed: 120, limit: 120 });
    expect(exhaust(() => rl.charge(peer, "/api/v1/agents", 5))).toEqual({ passed: 120, limit: 120 });
  });
});

describe("[验收线 4] 429 日志", () => {
  test("同一桶一分钟内多次 429 只记一行，带次数；下一分钟再记", () => {
    const lines: string[] = [];
    const rl = createApiRateLimiter((l) => lines.push(l));
    const { full } = ownerViews();
    const now = 1_000_000;
    exhaust(() => rl.charge(full, "/api/v1/agents", now));
    for (let i = 0; i < 5; i++) expect(rl.charge(full, "/api/v1/agents", now + i)).toEqual({ limit: 600 });
    expect(lines).toEqual(["[api-rate] 429 who=owner path=/api/v1/agents n=601 limit=600"]);
    expect(rl.charge(full, "/api/v1/agents", now + 60_000)).toBeNull(); // 窗口滑过，放行不记
    exhaust(() => rl.charge(full, "/api/v1/agents", now + 60_000));
    expect(lines.length).toBe(2);
  });

  test("不出现 token 明文、token id、设备 id、IP、查询串", () => {
    const lines: string[] = [];
    const rl = createApiRateLimiter((l) => lines.push(l));
    const peer = newTokenPrincipal("peer-x", ["*"], { peer: "x" });
    const script = newTokenPrincipal("script", ["*"]);
    const { limited, tokens } = ownerViews();
    const path = `/api/v1/devices/${limited.credential}/tok/${script.id.slice(6)}?token=${script.secret}&ip=192.168.1.9`;
    for (const p of [peer, script, limited]) exhaust(() => rl.charge(p, path, 7));
    expect(lines).toEqual([
      "[api-rate] 429 who=peer:x path=/api/v1/devices/:id/tok/:id n=121 limit=120",
      "[api-rate] 429 who=token:script path=/api/v1/devices/:id/tok/:id n=121 limit=120",
      "[api-rate] 429 who=owner path=/api/v1/devices/:id/tok/:id n=601 limit=600",
    ]);
    const text = lines.join("\n");
    for (const secret of [peer.secret!, script.secret!, peer.id, script.id.slice(6), limited.credential!, ...tokens, "192.168.1.9", "?"]) {
      expect(text).not.toContain(secret);
    }
  });

  test("路由模板：像 id 的段换成 :id", () => {
    expect(routeTemplate("/api/v1/features/F-12/snapshot")).toBe("/api/v1/features/:id/snapshot");
    expect(routeTemplate("/api/v1/asks")).toBe("/api/v1/asks");
  });
});
