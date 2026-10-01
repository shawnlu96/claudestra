/**
 * i28-W1 一次授权的判定与 v1 迁移（src/lib/lend-grant-rules.ts、lend-config.ts migrateV1、lend-policy.ts effectiveLend）：
 * 暂停 / 缺到期时间 / 过期 / 超 7 天 / 写单开关关着时含 write 都整条不生效；v1 条目一律迁成暂停，任何边界都不放宽，迁移可以重跑。
 * 写单已开（i28-R7e）：授权里写了 write 才接写单，没写的照旧只接审查单。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lendFileProblem, migrateV1, readLend, readLendSync, updateLend, V1_PAUSED_REASON, type LendEntry } from "../src/lib/lend-config.js";
import { GRANT_MAX_MS, grantProblem, WRITE_ROLE_OPEN } from "../src/lib/lend-grant-rules.js";
import { effectiveLend } from "../src/lib/lend-policy.js";

const FP = "aaaa-bbbb-cccc-dddd";
const T = Date.parse("2026-10-01T00:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const G: LendEntry = { peer: "team-a", fp: FP, families: { codex: 5 }, roles: ["review"], repos: ["o/r"], ordersPerDay: 200, grantedAt: iso(T), until: iso(T + 3 * DAY) };
const contacts = [{ name: "team-a", fp: FP }, { name: "team-b", fp: "1111-2222-3333-4444" }];
const tmp = () => join(mkdtempSync(join(tmpdir(), "lend-grant-")), "lend.json");

describe("授权判定（grantProblem）", () => {
  test("有效的授权：null", () => {
    expect(grantProblem(G, T + DAY)).toBeNull();
  });

  test("写单开关：生产缺省开着，含 write 的授权生效；开关关上（writeOpen=false）则含 write 的整条不生效", () => {
    expect(WRITE_ROLE_OPEN).toBe(true);
    expect(grantProblem({ ...G, roles: ["review", "write"] }, T)).toBeNull();
    expect(grantProblem({ ...G, roles: ["write"] }, T)).toBeNull();
    expect(grantProblem({ ...G, roles: ["review", "write"] }, T, false)).toMatch(/write/);
    expect(grantProblem({ ...G, roles: ["write"] }, T, false)).toMatch(/write/);
    expect(grantProblem(G, T, false)).toBeNull();
  });

  test("P1-3 没写到期时间 / 授权时间 / 指纹，期限超过 7 天（按授权时刻和按现在都算），授权时间在未来：都不生效", () => {
    for (const k of ["until", "grantedAt", "fp"] as const) {
      const e = { ...G };
      delete e[k];
      expect(grantProblem(e, T), k).toMatch(/缺/);
    }
    expect(grantProblem({ ...G, until: iso(T + GRANT_MAX_MS + 1) }, T)).toMatch(/7 天/);
    expect(grantProblem({ ...G, until: iso(T + GRANT_MAX_MS) }, T)).toBeNull();
    expect(grantProblem({ ...G, grantedAt: iso(T + 3 * DAY), until: iso(T + 9 * DAY) }, T)).toMatch(/未来/); // 手改把授权时刻挪到以后
    expect(grantProblem({ ...G, grantedAt: iso(T + 3 * DAY), until: iso(T + 9 * DAY) }, T + 4 * DAY)).toBeNull();
  });

  test("到期、暂停：不生效", () => {
    expect(grantProblem(G, T + 3 * DAY)).toMatch(/到期/);
    expect(grantProblem({ ...G, paused: { reason: "等重新授权" } }, T)).toMatch(/暂停/);
  });

  test("effectiveLend 用同一套判定：不生效的列进 dropped，指纹对不上的联系人也剔", () => {
    const file = { version: 2 as const, enabled: true, borrow: [], lend: [G, { ...G, peer: "team-b", fp: "1111-2222-3333-4444", roles: ["review", "write"] as LendEntry["roles"] }] };
    expect(effectiveLend({ status: "ok", file }, contacts, [], T + DAY).lend.map((e) => e.peer)).toEqual(["team-a", "team-b"]);
    const eff = effectiveLend({ status: "ok", file }, contacts, [], T + DAY, false);
    expect(eff.lend.map((e) => e.peer)).toEqual(["team-a"]);
    expect(eff.dropped.join()).toContain("team-b");
    expect(effectiveLend({ status: "ok", file }, [{ name: "team-a", fp: "9999-9999-9999-9999" }], [], T + DAY).lending).toBe(false);
  });
});

const v1Entry = (over: Record<string, unknown> = {}) => ({ peer: "team-a", fp: FP, families: { codex: 2 }, roles: ["review"], repos: ["o/r"],
  quota: { ordersPerDay: 5, tokensPerDay: null }, confirm: "per-order", ...over });
const v1File = (lend: unknown[]) => ({ version: 1, enabled: true, borrow: [{ peer: "team-b", projects: ["p"], roles: ["review"], maxOpen: 2 }], lend });

describe("P1-5 v1 → v2 迁移", () => {
  test("逐单确认、限时预先授权（还没到期）、含 write 的都迁成暂停；字段原样搬，不补到期 / 授权时刻；借入原样", () => {
    const v1 = v1File([
      v1Entry(),
      v1Entry({ peer: "team-b", fp: "1111-2222-3333-4444", confirm: "auto", until: iso(T + DAY) }),
      v1Entry({ peer: "team-c", fp: undefined, roles: ["review", "write"], confirm: "auto", until: iso(T + 30 * DAY) }),
    ]);
    const m = migrateV1(JSON.parse(JSON.stringify(v1)));
    expect(m.version).toBe(2);
    expect(m.borrow).toEqual(v1.borrow as never);
    expect(m.lend[0]).toEqual({ peer: "team-a", fp: FP, families: { codex: 2 }, roles: ["review"], repos: ["o/r"], ordersPerDay: 5, paused: { reason: V1_PAUSED_REASON } });
    expect(m.lend[1]).toMatchObject({ until: iso(T + DAY), paused: { reason: V1_PAUSED_REASON } });
    expect(m.lend[2]).toMatchObject({ roles: ["review", "write"], paused: { reason: V1_PAUSED_REASON } });
    for (const e of m.lend) expect(e.grantedAt).toBeUndefined();
    expect(lendFileProblem(m)).toBeNull();
    const eff = effectiveLend({ status: "ok", file: m }, [...contacts, { name: "team-c" }], [], T);
    expect(eff.lend).toEqual([]);
    expect(eff.dropped.filter((x) => x.includes("暂停"))).toHaveLength(3);
  });

  test("读：照读不写盘、标 migrated；同步读一样；重跑结果相同；写一次就落 v2，再读和迁移结果一致", async () => {
    const p = tmp();
    const raw = JSON.stringify(v1File([v1Entry({ confirm: "auto", until: iso(Date.now() + DAY) })]));
    writeFileSync(p, raw);
    const a = await readLend(p);
    const b = await readLend(p);
    expect(a).toMatchObject({ status: "ok", migrated: true });
    expect(b).toEqual(a);
    expect(readLendSync(p)).toEqual(a);
    expect(readFileSync(p, "utf8")).toBe(raw);
    await updateLend(() => undefined, p); // 没改动：不写
    expect(readFileSync(p, "utf8")).toBe(raw);
    await updateLend((f) => { f.borrow[0].maxOpen = 3; }, p);
    const after = await readLend(p);
    expect(after.status).toBe("ok");
    expect(after).not.toHaveProperty("migrated");
    expect(JSON.parse(readFileSync(p, "utf8")).version).toBe(2);
    expect(after.file.lend).toEqual(a.file.lend);
  });

  test("v2 里不认识 v1 的写法（confirm / quota）：整份无效，按关处理", async () => {
    const p = tmp();
    writeFileSync(p, JSON.stringify({ version: 2, enabled: true, borrow: [], lend: [{ ...G, confirm: "auto" }] }));
    expect(await readLend(p)).toMatchObject({ status: "invalid" });
  });
});

describe("P1 生产依赖的写单开关只认 WRITE_ROLE_OPEN（writeOpen 只能由测试注入）", () => {
  test("lendDeps 不设 writeOpen；按真实状态目录现读：写了 write 的授权接写单，没写的只接审查单", async () => {
    const { lendDeps } = await import("../src/lib/lend-deps.js");
    const { openLendJournal } = await import("../src/lib/lend-journal.js");
    const { LedgerReader } = await import("../src/lib/ledger-read.js");
    const { liveGrant } = await import("../src/lib/lend-grant.js");
    const { LEND_PATH } = await import("../src/lib/lend-config.js");
    const { statePath } = await import("../src/lib/paths.js");
    const files = [LEND_PATH, statePath("peers.json")];
    const before = files.map((f) => (existsSync(f) ? readFileSync(f, "utf8") : null)); // 测试共用一个临时状态目录：用完原样放回
    const reader = new LedgerReader();
    const db = openLendJournal(":memory:");
    try {
      const d = lendDeps(db, reader, () => {}, undefined);
      expect(d.writeOpen).toBeUndefined();
      const now = Date.now();
      writeFileSync(statePath("peers.json"), JSON.stringify({ httpPeers: [{ name: "team-a", fp: FP, addedAt: "" }], pendingInvites: [] }));
      writeFileSync(LEND_PATH, JSON.stringify({ version: 2, enabled: true, borrow: [],
        lend: [{ ...G, roles: ["review", "write"], grantedAt: iso(now), until: iso(now + DAY) }] }));
      const write = { peer: "team-a", fp: FP, family: "codex", preview: { repo: "o/r", step: "write" } };
      const review = { ...write, preview: { repo: "o/r", step: "review" } };
      expect(await liveGrant(write, d)).toMatchObject({ ok: true });
      expect(await liveGrant(review, d)).toMatchObject({ ok: true });
      writeFileSync(LEND_PATH, JSON.stringify({ version: 2, enabled: true, borrow: [], lend: [{ ...G, grantedAt: iso(now), until: iso(now + DAY) }] }));
      expect(await liveGrant(write, d)).toMatchObject({ ok: false, problem: expect.stringContaining("write") });
      expect(await liveGrant(review, d)).toMatchObject({ ok: true });
    } finally {
      db.close();
      reader.close();
      files.forEach((f, i) => (before[i] === null ? rmSync(f, { force: true }) : writeFileSync(f, before[i]!)));
    }
  });
});
