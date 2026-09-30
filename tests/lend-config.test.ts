/**
 * lend.json（lib/lend-config.ts / lib/lend-policy.ts / lib/doctor-lend.ts）：缺省值、校验、原子写 + 锁、无效文件按关处理、
 * 联系人校验、个人项目拒绝；以及 lend / borrow 的写子命令过认主守卫、只许 owner / master 改。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { checkLend } from "../src/lib/doctor-lend.js";
import { defaultLendFile, lendFileProblem, readLend, updateLend, type LendFile } from "../src/lib/lend-config.js";
import { buildBorrowEntry, buildLendEntry, effectiveLend, isPersonalProject, resolveContact, type LendContact } from "../src/lib/lend-policy.js";
import type { ProjectDef } from "../src/lib/projects.js";
import { writeTextAtomicSync } from "../src/lib/state-file.js";
import { isWriteInvocation } from "../src/manager/write-commands.js";
import { ownerOrMasterError } from "../src/manager/project-guard.js";

const tmpPath = () => join(mkdtempSync(join(tmpdir(), "lend-")), "lend.json");
const FP_A = "aaaa-bbbb-cccc-dddd";
const FP_B = "1111-2222-3333-4444";
const contacts: LendContact[] = [
  { name: "team-a", fp: FP_A },
  { name: "mate-b", fp: FP_B },
  { name: "old", fp: "9999-9999-9999-9999", disabled: true },
];
const proj = (id: string, dirs: string[], personal?: boolean): ProjectDef & { personal?: boolean } =>
  ({ id, name: id, dirs, createdAt: "", ...(personal ? { personal } : {}) });
const HOME = process.env.HOME || "/Users/x";
/** 目录要真实存在：解析不了的目录按个人项目处理 */
const repoDir = (n: string) => { const d = join(mkdtempSync(join(tmpdir(), "lend-repo-")), n); mkdirSync(d); return d; };
const projects = [
  proj("claude-orchestrator", [repoDir("claude-orchestrator")]),
  proj("diary", [repoDir("diary")], true),
  proj("home", [HOME, repoDir("router")]),
  proj("scratch", ["/tmp"]),
];
const lendOk = (over: Partial<Parameters<typeof buildLendEntry>[0]> = {}) =>
  buildLendEntry({ ref: "team-a", families: { codex: "2" }, repos: "shawnlu96/claudestra", ...over }, contacts);
const validFile = (): LendFile => {
  const l = lendOk();
  const b = buildBorrowEntry({ ref: "mate-b", projects: "claude-orchestrator" }, contacts, projects);
  if (!l.ok || !b.ok) throw new Error("fixture");
  return { version: 1, enabled: true, lend: [l.entry], borrow: [b.entry] };
};

describe("缺省值", () => {
  test("文件不存在 = 不出借、不借入", async () => {
    const r = await readLend(tmpPath());
    expect(r.status).toBe("missing");
    expect(r.file).toEqual({ version: 1, enabled: false, lend: [], borrow: [] });
    const eff = effectiveLend(r, contacts, projects);
    expect(eff).toMatchObject({ lending: false, lend: [], borrow: [] });
  });
  test("lend set 的缺省：只 review、逐单确认、每天 5 单、tokensPerDay 预留为 null；borrow maxOpen 3", () => {
    const l = lendOk();
    expect(l.ok && l.entry).toEqual({
      peer: "team-a", fp: FP_A, families: { codex: 2 }, roles: ["review"], repos: ["shawnlu96/claudestra"],
      quota: { ordersPerDay: 5, tokensPerDay: null }, confirm: "per-order",
    });
    const b = buildBorrowEntry({ ref: "mate-b", projects: "claude-orchestrator" }, contacts, projects);
    expect(b.ok && b.entry).toEqual({ peer: "mate-b", fp: FP_B, projects: ["claude-orchestrator"], roles: ["review"], maxOpen: 3 });
  });
});

describe("校验", () => {
  test("合法文件通过；缺版本 / 不认识的版本 / enabled 不是布尔都算无效", () => {
    expect(lendFileProblem(validFile())).toBeNull();
    const { version: _v, ...noVer } = validFile();
    expect(lendFileProblem(noVer)).toContain("version");
    expect(lendFileProblem({ ...validFile(), version: 2 })).toContain("version");
    expect(lendFileProblem({ ...validFile(), enabled: "yes" })).toContain("enabled");
  });
  test("条目里任一字段不对，整份无效", () => {
    const bad = (mut: (f: LendFile) => void) => { const f = validFile(); mut(f); return lendFileProblem(f); };
    expect(bad((f) => { f.lend[0].families = { gpt: 1 } as never; })).toContain("家族");
    expect(bad((f) => { f.lend[0].families = { codex: 99 }; })).toContain("families.codex");
    expect(bad((f) => { f.lend[0].repos = ["../etc"]; })).toContain("repos");
    expect(bad((f) => { f.lend[0].confirm = "maybe" as never; })).toContain("confirm");
    expect(bad((f) => { f.lend[0].quota = { ordersPerDay: 5, tokensPerDay: 1000 as never }; })).toContain("tokensPerDay");
    expect(bad((f) => { f.lend.push({ ...f.lend[0] }); })).toContain("两次");
    expect(bad((f) => { f.borrow[0].maxOpen = 0; })).toContain("maxOpen");
    expect(bad((f) => { f.borrow[0].fp = "not-a-fp"; })).toContain("fp");
  });
  test("CLI 输入：至少一个家族出位、仓库要是 owner/repo、write 角色先拒、until 要在未来", () => {
    expect(lendOk({ families: { codex: "0" } })).toMatchObject({ ok: false });
    expect(lendOk({ families: { codex: "2x" } })).toMatchObject({ ok: false });
    expect(lendOk({ repos: undefined })).toMatchObject({ ok: false });
    expect(lendOk({ repos: "https://github.com/a/b" })).toMatchObject({ ok: false });
    expect(lendOk({ roles: "review,write" })).toMatchObject({ ok: false });
    expect(lendOk({ confirm: "auto" })).toMatchObject({ ok: false }); // 预先授权必须限时（specRev 2）
    expect(lendOk({ confirm: "auto", until: "2100-01-01T00:00:00Z" })).toMatchObject({ ok: true, entry: { confirm: "auto", until: "2100-01-01T00:00:00.000Z" } });
    expect(lendOk({ confirm: "yes" })).toMatchObject({ ok: false });
    expect(lendOk({ until: "2020-01-01T00:00:00Z" })).toMatchObject({ ok: false });
    expect(lendOk({ ordersPerDay: "0" })).toMatchObject({ ok: false });
  });
});

describe("无效文件按关处理", () => {
  test("JSON 坏 / 结构不对：读成缺省（关），带原因；有效视图全空", async () => {
    for (const raw of ["{not json", JSON.stringify({ ...validFile(), version: 9 }), JSON.stringify({ ...validFile(), lend: [{ peer: "team-a" }] })]) {
      const p = tmpPath();
      writeFileSync(p, raw);
      const r = await readLend(p);
      expect(r.status).toBe("invalid");
      expect(r.file.enabled).toBe(false);
      const eff = effectiveLend(r, contacts, projects);
      expect(eff.lending).toBe(false);
      expect(eff.borrow).toEqual([]);
      expect(eff.invalid).toBeTruthy();
    }
  });
  test("先写好一份，再被写坏：不沿用上次好的值（fail-closed）", async () => {
    const p = tmpPath();
    await updateLend((f) => Object.assign(f, validFile()), p);
    expect(effectiveLend(await readLend(p), contacts, projects).lending).toBe(true);
    writeFileSync(p, "{");
    expect(effectiveLend(await readLend(p), contacts, projects).lending).toBe(false);
  });
  test("enabled 必须严格是 true 才出借；借入不受出借开关影响", () => {
    const f = { ...validFile(), enabled: false };
    const eff = effectiveLend({ status: "ok", file: f }, contacts, projects);
    expect(eff.lending).toBe(false);
    expect(eff.borrow.length).toBe(1);
  });
  test("写者拒绝覆盖无效文件，文件原样留着", async () => {
    const p = tmpPath();
    writeFileSync(p, "{broken");
    await expect(updateLend((f) => { f.enabled = true; }, p)).rejects.toThrow("无效");
    expect(readFileSync(p, "utf8")).toBe("{broken");
  });
  test("doctor：无效 → fail；正常 → 一行写清对谁、上限；缺省 → 关", async () => {
    const p = tmpPath();
    expect((await checkLend(p, { contacts, projects }))[0]).toMatchObject({ status: "ok", detail: "出借：关；借入：无" });
    await updateLend((f) => Object.assign(f, validFile()), p);
    const ok = (await checkLend(p, { contacts, projects }))[0];
    expect(ok.status).toBe("ok");
    expect(ok.detail).toContain("team-a（codex 2，每天 5 单，逐单确认）");
    expect(ok.detail).toContain("借入：mate-b（claude-orchestrator");
    writeFileSync(p, "[]");
    expect((await checkLend(p, { contacts, projects }))[0]).toMatchObject({ status: "fail" });
  });
});

describe("原子写与锁", () => {
  test("写完是 0600、没有残留的 tmp 文件、内容能读回", async () => {
    const p = tmpPath();
    await updateLend((f) => Object.assign(f, validFile()), p);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(p, "..")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect((await readLend(p)).file).toEqual(validFile());
  });
  test("锁被别人持有：等不到就拒写（不降级照写）", async () => {
    const p = tmpPath();
    const held = await acquireLock(`${p}.lock`, 0);
    try {
      await expect(updateLend((f) => { f.enabled = true; }, p, 300)).rejects.toThrow("占着");
      expect(existsSync(p)).toBe(false);
    } finally { held?.release(); }
  });
  test("并发的 set 互不吃掉对方（锁内重读）", async () => {
    const p = tmpPath();
    const names = Array.from({ length: 8 }, (_, i) => `p${i}`);
    await Promise.all(names.map((n) => updateLend((f) => {
      f.borrow.push({ peer: n, projects: ["claude-orchestrator"], roles: ["review"], maxOpen: 1 });
    }, p)));
    expect((await readLend(p)).file.borrow.map((e) => e.peer).sort()).toEqual(names);
  });
  test("改完不合法就不写；内容没变不写", async () => {
    const p = tmpPath();
    await expect(updateLend((f) => { f.lend.push({ peer: "x" } as never); }, p)).rejects.toThrow("不合法");
    expect(existsSync(p)).toBe(false);
    await updateLend(() => undefined, p);
    expect(existsSync(p)).toBe(false);
    expect(defaultLendFile().enabled).toBe(false);
  });
});

describe("联系人校验", () => {
  test("按名字或指纹认；不在联系人里 / 已禁用 / 指纹重名都拒", () => {
    expect(resolveContact(contacts, "team-a")).toEqual({ ok: true, entry: { peer: "team-a", fp: FP_A } });
    expect(resolveContact(contacts, FP_B.toUpperCase())).toEqual({ ok: true, entry: { peer: "mate-b", fp: FP_B } });
    expect(resolveContact(contacts, "stranger")).toMatchObject({ ok: false });
    expect(resolveContact(contacts, "old")).toMatchObject({ ok: false, error: expect.stringContaining("禁用") });
    const dup = [...contacts, { name: "twin", fp: FP_A }];
    expect(resolveContact(dup, FP_A)).toMatchObject({ ok: false });
    expect(lendOk({ ref: "stranger" })).toMatchObject({ ok: false });
    expect(buildBorrowEntry({ ref: "stranger", projects: "claude-orchestrator" }, contacts, projects)).toMatchObject({ ok: false });
  });
  test("读取时再核一遍：peer 被删 / 禁用 / 换了实例（指纹变了）的条目当场失效", () => {
    const read = { status: "ok" as const, file: validFile() };
    expect(effectiveLend(read, contacts, projects).lending).toBe(true);
    for (const now of [
      contacts.filter((c) => c.name !== "team-a"),
      contacts.map((c) => (c.name === "team-a" ? { ...c, disabled: true } : c)),
      contacts.map((c) => (c.name === "team-a" ? { ...c, fp: "0000-0000-0000-0000" } : c)),
    ]) {
      const eff = effectiveLend(read, now, projects);
      expect(eff.lending).toBe(false);
      expect(eff.dropped[0]).toContain("team-a");
    }
  });
  test("until 过了的出借条目失效", () => {
    const f = validFile();
    f.lend[0].until = "2026-01-01T00:00:00.000Z";
    const eff = effectiveLend({ status: "ok", file: f }, contacts, projects, Date.parse("2026-02-01T00:00:00Z"));
    expect(eff.lending).toBe(false);
    expect(eff.dropped[0]).toContain("到期");
  });
  test("预先授权（auto）：until 之前算数；到期或没写 until → 条目照常出借但退回逐单确认（specRev 2）", () => {
    const at = (until: string | undefined, now: string) => {
      const f = validFile();
      f.lend[0] = { ...f.lend[0], confirm: "auto", ...(until ? { until } : {}) };
      if (!until) delete f.lend[0].until;
      return effectiveLend({ status: "ok", file: f }, contacts, projects, Date.parse(now));
    };
    expect(at("2026-01-01T00:00:00.000Z", "2025-12-31T00:00:00Z").lend[0]).toMatchObject({ confirm: "auto" });
    for (const eff of [at("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01Z"), at(undefined, "2025-01-01T00:00:00Z")]) {
      expect(eff.lending).toBe(true);
      expect(eff.lend[0].confirm).toBe("per-order");
      expect(eff.lend[0].until).toBeUndefined();
      expect(eff.dropped[0]).toContain("按逐单确认");
    }
  });
});

describe("个人项目永不外借", () => {
  test("显式标记，或目录含家目录 / 临时目录，都算个人项目", () => {
    expect(isPersonalProject(projects[0])).toBe(false);
    expect(isPersonalProject(projects[1])).toBe(true);
    expect(isPersonalProject(projects[2])).toBe(true);
    expect(isPersonalProject(projects[3])).toBe(true);
  });
  test("borrow set 拒个人项目与不存在的项目（一个都不写）", () => {
    for (const ids of ["diary", "claude-orchestrator,home", "scratch", "nope"]) {
      expect(buildBorrowEntry({ ref: "mate-b", projects: ids }, contacts, projects)).toMatchObject({ ok: false });
    }
  });
  test("写进去之后项目才被标成个人项目：读取时剔掉，剩下的照常；全剔光就整条不生效", () => {
    const f = validFile();
    f.borrow[0].projects = ["claude-orchestrator", "diary"];
    const eff = effectiveLend({ status: "ok", file: f }, contacts, projects);
    expect(eff.borrow[0].projects).toEqual(["claude-orchestrator"]);
    expect(eff.dropped.join()).toContain("diary");
    const marked = projects.map((p) => (p.id === "claude-orchestrator" ? { ...p, personal: true } : p));
    expect(effectiveLend({ status: "ok", file: f }, contacts, marked).borrow).toEqual([]);
  });
});

describe("命令权限", () => {
  test("lend / borrow 的 set、off 是写（过认主守卫），status 是读", () => {
    for (const c of ["lend", "borrow"]) {
      expect(isWriteInvocation(c, ["set", "x"])).toBe(true);
      expect(isWriteInvocation(c, ["off"])).toBe(true);
      expect(isWriteInvocation(c, ["status"])).toBe(false);
      expect(isWriteInvocation(c, [])).toBe(false);
    }
  });
  test("只许 owner（没有频道）或 master（控制频道）；PM / 执行者 / 认不出的频道都拒", () => {
    const agents = { "agent-pm": { channelId: "1" } };
    const as = (channelId?: string) => ownerOrMasterError({ channelId, controlChannelId: "9" }, agents, "改出借声明");
    expect(as(undefined)).toBeNull();
    expect(as("9")).toBeNull();
    expect(as("1")?.error).toContain("agent-pm 不能改出借声明");
    expect(as("404")).not.toBeNull();
  });
});

describe("T88 r1 回归", () => {
  const real = mkdtempSync(join(tmpdir(), "lend-real-"));
  const links = mkdtempSync(join(tmpdir(), "lend-links-"));
  const alias = (name: string, target: string) => { const p = join(links, name); symlinkSync(target, p); return p; };
  test("P1-1 家目录 / 根 / 临时目录的软链别名也算个人项目（写入拒、effective 剔）", () => {
    const aliases = [alias("home", HOME), alias("root", "/"), alias("tmp", "/tmp"), alias("systmp", tmpdir())];
    for (const a of aliases) {
      const p = proj("alias", [a]);
      expect(isPersonalProject(p), a).toBe(true);
      expect(buildBorrowEntry({ ref: "mate-b", projects: "alias" }, contacts, [p]), a).toMatchObject({ ok: false });
      const f = validFile();
      f.borrow[0].projects = ["alias"];
      expect(effectiveLend({ status: "ok", file: f }, contacts, [p]).borrow, a).toEqual([]);
    }
  });
  test("P1-1 解析不了的目录按个人项目处理（fail-closed）；普通子目录不误伤", () => {
    expect(isPersonalProject(proj("gone", ["/no/such/dir-for-lend-test"]))).toBe(true);
    expect(isPersonalProject(proj("ok", [real]))).toBe(false);
    expect(isPersonalProject(proj("ok2", [alias("real", real)]))).toBe(false);
  });
  test("P1-2 失租的旧 writer 恢复后不能覆盖新 writer 已提交的内容", async () => {
    const p = tmpPath();
    let resume!: () => void;
    const gate = new Promise<void>((r) => { resume = r; });
    let entered!: () => void;
    const inA = new Promise<void>((r) => { entered = r; });
    const a = updateLend(async (f) => {
      entered();
      await gate;
      f.borrow.push({ peer: "first", projects: ["claude-orchestrator"], roles: ["review"], maxOpen: 1 });
    }, p);
    await inA;
    const old = new Date(Date.now() - 181_000);
    utimesSync(`${p}.lock`, old, old); // 模拟 A 暂停超过锁期限
    await updateLend((f) => { f.borrow.push({ peer: "second", projects: ["claude-orchestrator"], roles: ["review"], maxOpen: 1 }); }, p);
    resume();
    await expect(a).rejects.toThrow("锁");
    expect((await readLend(p)).file.borrow.map((e) => e.peer)).toEqual(["second"]);
  });
  test("P1-2 原子写底座：提交前核验不过就不 rename、不留 tmp", () => {
    const dir = mkdtempSync(join(tmpdir(), "lend-commit-"));
    const target = join(dir, "x.json");
    writeFileSync(target, "{\"v\":1}");
    expect(() => writeTextAtomicSync(target, "{\"v\":2}", { commitIf: () => false })).toThrow();
    expect(readFileSync(target, "utf8")).toBe("{\"v\":1}");
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });
});
