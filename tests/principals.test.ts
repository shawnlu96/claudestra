/**
 * v2.6.0+ principals（API token 身份与授权）纯逻辑测试。
 * 文件 IO（readPrincipals/writePrincipals）走临时目录，不碰真实配置。
 */
import { describe, test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import {
  newTokenPrincipal,
  reservedNameError,
  isOwnerPrincipal,
  tokenIdOf,
  findByBearer,
  findToken,
  agentInScope,
  terminalAllowed,
  SlidingWindowLimiter,
  readPrincipals,
  warnMasterVariants,
  writePrincipals,
  updatePrincipals,
  principalsLockPath,
  type Principal,
  type PrincipalsFile,
} from "../src/lib/principals.ts";
import { acquireLock } from "../src/lib/file-lock.ts";

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

describe("保留名 web-ui（isOwnerPrincipal 凭它认老 web 前端的 owner token，T32）", () => {
  test("新签的 token 不许叫 web-ui：大小写、首尾空白都拦；别的名字照签", () => {
    for (const n of ["web-ui", "Web-UI", " web-ui ", "WEB-UI\t"]) {
      expect([n, reservedNameError(n)]).toEqual([n, expect.stringContaining("保留名")]);
      expect(() => newTokenPrincipal(n, ["*"])).toThrow("保留名");
    }
    for (const n of ["web-ui-2", "webui", "peer-web-ui", "张三"]) {
      expect([n, reservedNameError(n)]).toEqual([n, null]);
      expect(isOwnerPrincipal(newTokenPrincipal(n, ["*"]))).toBe(false);
    }
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
    const p = newTokenPrincipal("owner-console", ["*", "master"]);
    expect(agentInScope(p, "master")).toBe(true);
  });

  test("普通 agent 按规范名比：大小写 / 全角 / 零宽变体是同一个，接口间不会一处认一处不认", () => {
    const p = newTokenPrincipal("t", ["CC"]); // T42 之前签出的老条目
    for (const name of ["cc", "agent-cc", "CC", "Agent-CC", "\uff43\uff43", "c\u200bc"]) expect(agentInScope(p, name)).toBe(true);
    expect(agentInScope(p, "agent-cc2")).toBe(false);
    expect(agentInScope(newTokenPrincipal("t", ["cc"]), "agent-CC")).toBe(true);
  });

  test("大总管变体：\"*\" 不含它们；老条目里的 MASTER / 全角变体也匹配不上大总管，只认逐字列出的 master", () => {
    for (const name of ["MASTER", "Agent-Master", "\uff4daster", "master\u200b"]) {
      expect(agentInScope(newTokenPrincipal("t", ["*"]), name)).toBe(false);
      expect(agentInScope(newTokenPrincipal("t", ["MASTER", "Agent-Master"]), "master")).toBe(false);
    }
    expect(agentInScope(newTokenPrincipal("t", ["*", "master"]), "agent-master")).toBe(true);
  });

  test("大总管只认名单里逐字的 master / agent-master：变体条目连请求里同样的写法也不放（T42-r2）", () => {
    for (const v of ["MASTER", "Master", "\uff4daster", "agent-agent-master", "__master__", " master "]) {
      expect([v, agentInScope(newTokenPrincipal("t", [v]), v)]).toEqual([v, false]);
      expect([v, agentInScope(newTokenPrincipal("t", ["master"]), v)]).toEqual([v, true]); // 逐字列了 master：任何写法的请求都是它
    }
    expect(agentInScope({ ...newTokenPrincipal("t", ["master"]), peer: "p" }, "MASTER")).toBe(false);
  });

  test('"*" 的变体（全角 ＊、agent-*）不是通配：老条目里有也不放行别的 agent', () => {
    expect(agentInScope(newTokenPrincipal("t", ["\uff0a", "agent-*"]), "agent-cc")).toBe(false);
  });
});

describe("warnMasterVariants：名单里的大总管变体只告警、不改盘（T42-r2）", () => {
  const legacy = (id: string, agents: string[], grant: string[] = []): Principal => ({
    ...newTokenPrincipal(id, agents), id: `guest:${id}`, credentials: grant.length ? [{ grant: { agents: grant } } as never] : undefined,
  });
  test("principal 的 agents 与凭据 grant 里的变体各报一次，写明 principal；逐字 master、普通名字不报；同一进程不重复", () => {
    const lines: string[] = [];
    const file = { principals: [legacy("old", ["MASTER", "cc"], ["\uff4daster"]), legacy("owner", ["*", "master", "agent-master"]), legacy("z", ["mastermind"])] };
    warnMasterVariants(file, (m) => lines.push(m));
    warnMasterVariants(file, (m) => lines.push(m));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("guest:old");
    expect(lines[0]).toContain('"MASTER"');
    expect(lines[1]).toContain('"\uff4daster"');
  });
  test("readPrincipals 读到变体照原样返回，文件不动", async () => {
    const path = join(tmpdir(), `principals-variant-${Date.now()}.json`);
    const raw = JSON.stringify({ principals: [legacy("disk", ["Agent-MASTER", "cc"])] });
    await Bun.write(path, raw);
    const warn = console.warn;
    const lines: string[] = [];
    console.warn = (m: string) => void lines.push(m);
    try {
      expect((await readPrincipals(path)).principals[0]!.agents).toEqual(["Agent-MASTER", "cc"]);
    } finally {
      console.warn = warn;
    }
    expect(lines.some((l) => l.includes("guest:disk"))).toBe(true);
    expect(await Bun.file(path).text()).toBe(raw);
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

describe("updatePrincipals（锁内读改写）", () => {
  test("锁内重读：并发的撤销不会被拿旧副本的续期写回来（codex 复核的撤销写竞态）", async () => {
    const path = join(tmpdir(), `principals-update-${Date.now()}.json`);
    const p = newTokenPrincipal("dev", ["*"]);
    await writePrincipals({ principals: [{ ...p, credentials: [{ id: "dev_1" } as never] }] }, path);
    const revoke = updatePrincipals((f) => {
      f.principals[0].credentials = [];
      return { changed: true, result: "revoked" };
    }, { path });
    const touch = updatePrincipals((f) => ({ changed: !!f.principals[0].credentials?.length, result: f.principals[0].credentials?.length ?? 0 }), { path });
    expect(await revoke).toBe("revoked");
    expect(await touch).toBe(0); // 续期在锁里重读，看到的已是撤销后的文件
    expect((await readPrincipals(path)).principals[0].credentials).toEqual([]);
  });
  test("锁被占且 onBusy=skip → 不读不写返回 null；锁释放后照常", async () => {
    const path = join(tmpdir(), `principals-busy-${Date.now()}.json`);
    await writePrincipals({ principals: [] }, path);
    const held = await acquireLock(principalsLockPath(path));
    expect(held).not.toBeNull();
    let called = false;
    expect(await updatePrincipals(() => ((called = true), { changed: false, result: 1 }), { path, waitMs: 50, onBusy: "skip" })).toBeNull();
    expect(called).toBe(false);
    held!.release();
    expect(await updatePrincipals(() => ({ changed: false, result: 2 }), { path, waitMs: 50, onBusy: "skip" })).toBe(2);
  });
});
