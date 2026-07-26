/**
 * v2.6.0+ principals（API token 身份与授权）纯逻辑测试。
 * 文件 IO（readPrincipals/writePrincipals）走临时目录，不碰真实配置。
 */
import { describe, test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import {
  newTokenPrincipal,
  tokenIdOf,
  findByBearer,
  findToken,
  agentInScope,
  terminalAllowed,
  SlidingWindowLimiter,
  readPrincipals,
  writePrincipals,
  type Principal,
  type PrincipalsFile,
} from "../src/lib/principals.ts";

describe("newTokenPrincipal", () => {
  test("生成 token: 前缀 id + 64 hex secret + 默认 mirror", () => {
    const p = newTokenPrincipal("张三", ["worker-a"]);
    expect(p.id).toMatch(/^token:tok_[0-9a-f]{8}$/);
    expect(p.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(p.role).toBe("external");
    expect(p.mirror).toBe(true);
    expect(tokenIdOf(p)).toBe(p.id.slice(6));
  });

  test("两次生成互不相同", () => {
    const a = newTokenPrincipal("a", ["x"]);
    const b = newTokenPrincipal("b", ["x"]);
    expect(a.id).not.toBe(b.id);
    expect(a.secret).not.toBe(b.secret);
  });
});

describe("findByBearer / findToken", () => {
  const p = newTokenPrincipal("外包", ["worker-a"]);
  const file: PrincipalsFile = { principals: [p] };

  test("secret 命中", () => {
    expect(findByBearer(file, p.secret!)).toBe(p);
  });

  test("错误 secret / 空 secret 不命中", () => {
    expect(findByBearer(file, "deadbeef")).toBeNull();
    expect(findByBearer(file, "")).toBeNull();
  });

  test("disabled 的 token 不能鉴权", () => {
    const disabled = { ...p, disabled: true };
    expect(findByBearer({ principals: [disabled] }, p.secret!)).toBeNull();
  });

  test("findToken 按短 id / 全 id / name 找", () => {
    expect(findToken(file, tokenIdOf(p))).toBe(p);
    expect(findToken(file, p.id)).toBe(p);
    expect(findToken(file, "外包")).toBe(p);
    expect(findToken(file, "不存在")).toBeNull();
  });
});

describe("agentInScope", () => {
  test("精确匹配 + agent- 前缀双向兼容", () => {
    const p = newTokenPrincipal("t", ["worker-a"]);
    expect(agentInScope(p, "worker-a")).toBe(true);
    expect(agentInScope(p, "agent-worker-a")).toBe(true);
    expect(agentInScope(p, "worker-b")).toBe(false);
    const p2 = newTokenPrincipal("t", ["agent-worker-a"]);
    expect(agentInScope(p2, "worker-a")).toBe(true);
    expect(agentInScope(p2, "agent-worker-a")).toBe(true);
  });

  test('"*" 覆盖普通 agent，但不含 master', () => {
    const p = newTokenPrincipal("t", ["*"]);
    expect(agentInScope(p, "agent-anything")).toBe(true);
    expect(agentInScope(p, "master")).toBe(false);
  });

  test("master 显式列出才放行", () => {
    const p = newTokenPrincipal("t", ["*", "master"]);
    expect(agentInScope(p, "master")).toBe(true);
  });

  // [fork] agent-master 变体也按 master 处理（堵 "*" token 经前缀变体绕过的 R1 漏洞）
  test('[fork] "agent-master" 变体不被 "*" 覆盖，显式 master 才放行', () => {
    const p = newTokenPrincipal("t", ["*"]);
    expect(agentInScope(p, "agent-master")).toBe(false);
    const p2 = newTokenPrincipal("t", ["*", "master"]);
    expect(agentInScope(p2, "agent-master")).toBe(true);
  });

  test("disabled 一律拒", () => {
    const p = { ...newTokenPrincipal("t", ["*"]), disabled: true };
    expect(agentInScope(p, "agent-x")).toBe(false);
  });

  // v2.15+ peer token 永不含 master（owner:「大总管不可能被 peer 分享出去」）
  // ——签发侧已无条件拒，这里测消费侧对历史遗留 token 的截断
  test("peer token 显式列了 master 也拒（老版本 --force 签出的遗留）", () => {
    const p = newTokenPrincipal("peer-x", ["*", "master"], { peer: "x" });
    expect(agentInScope(p, "master")).toBe(false);
    expect(agentInScope(p, "agent-master")).toBe(false);
    expect(agentInScope(p, "agent-worker")).toBe(true);
  });

  test("非 peer token 的 master 显式授权不受影响", () => {
    const p = newTokenPrincipal("web-ui", ["*", "master"]);
    expect(agentInScope(p, "master")).toBe(true);
  });
});

describe("SlidingWindowLimiter", () => {
  test("窗口内放行 limit 次，第 limit+1 次拒绝", () => {
    const l = new SlidingWindowLimiter(3, 1000);
    const t0 = 1_000_000;
    expect(l.tryAcquire(t0)).toBe(true);
    expect(l.tryAcquire(t0 + 1)).toBe(true);
    expect(l.tryAcquire(t0 + 2)).toBe(true);
    expect(l.tryAcquire(t0 + 3)).toBe(false);
    expect(l.used(t0 + 3)).toBe(3);
  });

  test("窗口滑过后重新放行", () => {
    const l = new SlidingWindowLimiter(2, 1000);
    const t0 = 1_000_000;
    expect(l.tryAcquire(t0)).toBe(true);
    expect(l.tryAcquire(t0 + 10)).toBe(true);
    expect(l.tryAcquire(t0 + 20)).toBe(false);
    // t0 的那次滑出窗口
    expect(l.tryAcquire(t0 + 1001)).toBe(true);
  });
});

describe("terminalAllowed（B2 远程终端能力位）", () => {
  const mk = (over: Partial<Principal>): Principal => ({
    id: "token:tok_x",
    role: "external",
    agents: ["worker"],
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  });

  test("external token 默认无终端权限（即便 agent 在 scope 内）", () => {
    expect(terminalAllowed(mk({ agents: ["worker"] }), "worker")).toBe(false);
  });

  test("external token + terminal:true 且 agent 在 scope → 允许", () => {
    expect(terminalAllowed(mk({ agents: ["worker"], terminal: true }), "worker")).toBe(true);
  });

  test("terminal:true 但 agent 不在 scope → 拒绝（scope 仍是前置条件）", () => {
    expect(terminalAllowed(mk({ agents: ["worker"], terminal: true }), "other")).toBe(false);
  });

  test("owner 默认允许（无需 terminal 字段）", () => {
    expect(terminalAllowed(mk({ role: "owner", agents: ["*", "master"] }), "worker")).toBe(true);
  });

  test('"*" scope + terminal 不覆盖 master（master 仍需显式 scope）', () => {
    expect(terminalAllowed(mk({ agents: ["*"], terminal: true }), "master")).toBe(false);
    expect(terminalAllowed(mk({ agents: ["*", "master"], terminal: true }), "master")).toBe(true);
  });

  test("disabled token → 拒绝", () => {
    expect(terminalAllowed(mk({ agents: ["worker"], terminal: true, disabled: true }), "worker")).toBe(false);
  });

  test("newTokenPrincipal opts.terminal 透传", () => {
    expect(newTokenPrincipal("t", ["a"]).terminal).toBeUndefined();
    expect(newTokenPrincipal("t", ["a"], { terminal: true }).terminal).toBe(true);
  });
});

describe("readPrincipals / writePrincipals（临时文件）", () => {
  test("往返一致 + 缺文件返回空", async () => {
    const path = join(tmpdir(), `principals-test-${Date.now()}.json`);
    expect((await readPrincipals(path)).principals).toEqual([]);
    const p = newTokenPrincipal("t", ["a"]);
    await writePrincipals({ principals: [p] }, path);
    const back = await readPrincipals(path);
    expect(back.principals.length).toBe(1);
    expect(back.principals[0].id).toBe(p.id);
    expect(back.principals[0].secret).toBe(p.secret);
  });

  test("损坏 JSON 返回空而不是抛异常", async () => {
    const path = join(tmpdir(), `principals-bad-${Date.now()}.json`);
    await Bun.write(path, "{not json");
    expect((await readPrincipals(path)).principals).toEqual([]);
  });
});
