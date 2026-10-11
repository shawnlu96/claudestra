/**
 * lib/role-model-settings.ts（TIER1）：默认表随版本发布（四个角色 Claude 全 Opus 5.5、Codex 照自己的配置）、读四态、坏值整份拒、
 * 唯一写入口的 rev CAS（含两个进程同时按同一版保存只成一个；提交前被暂停、锁被回收的迟到写者被拒，不覆盖后来者）、锁被占 busy、坏文件另存后重写、读不了不写。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { testChildEnv } from "./test-env.js";
import { CARD_DEFAULT_MODEL, CARD_ROLES, loadCardRole } from "../src/lib/card-role-definitions.js";
import {
  defaultRoleModels, parseRoleModelPatch, readRoleModels, roleModelOf, roleModelsProblem, saveRoleModels, type RoleModelTable,
} from "../src/lib/role-model-settings.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "role-models-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const fileIn = (d: string) => join(d, "role-model-settings.json");

describe("默认表", () => {
  test("四个卡片角色 Claude 都是 Opus 5.5，Codex 都照 Codex 自己的配置（不自动降档）", () => {
    const t = defaultRoleModels();
    expect(CARD_DEFAULT_MODEL).toBe("claude-opus-5-5");
    expect(Object.keys(t.roles)).toEqual([...CARD_ROLES]);
    for (const r of CARD_ROLES) expect(t.roles[r]).toEqual({ claude: "claude-opus-5-5", codex: null });
    expect(t.rev).toBe(0);
    expect(roleModelsProblem(t)).toBeNull();
  });

  test("与仓库里每个角色定义文件写的模型一致", () => {
    for (const r of CARD_ROLES) {
      const def = loadCardRole(r);
      expect("error" in def ? def.error : def.model).toBe(defaultRoleModels().roles[r].claude);
    }
  });
});

describe("读", () => {
  test("没文件 = missing + 默认表；来源 default", () => {
    const r = readRoleModels(fileIn(tmp()));
    expect(r.status).toBe("missing");
    expect(roleModelOf(r, "author", "claude")).toEqual({ value: "claude-opus-5-5", source: "default" });
  });

  test("坏 JSON / 多字段 / 缺角色 / Codex 列写了 Claude 模型名 = invalid，按默认表执行", () => {
    const d = tmp(), p = fileIn(d);
    const good = defaultRoleModels();
    const cases: unknown[] = ["{bad", { ...good, extra: 1 }, { ...good, roles: { author: good.roles.author } },
      { ...good, roles: { ...good.roles, reviewer: { claude: "claude-opus-5-5", codex: "claude-haiku-5-5" } } },
      { ...good, roles: { ...good.roles, reviewer: { claude: "gpt-6", codex: null } } }];
    for (const c of cases) {
      writeFileSync(p, typeof c === "string" ? c : JSON.stringify(c));
      const r = readRoleModels(p);
      expect(r.status).toBe("invalid");
      expect(r.table).toEqual(defaultRoleModels());
      expect(roleModelOf(r, "reviewer", "claude").source).toBe("error");
    }
  });

  test("读不了（路径是目录）= unreadable", () => {
    const d = tmp(), p = fileIn(d);
    mkdirSync(p);
    expect(readRoleModels(p).status).toBe("unreadable");
  });
});

describe("补丁校验：坏值整份拒", () => {
  test.each([
    [null, "JSON 对象"], [{ rev: 0, role: "author" }, "没有要改的"], [{ rev: -1, role: "author", claude: "claude-opus-5-5" }, "rev"],
    [{ rev: 0, role: "boss", claude: "claude-opus-5-5" }, "role"], [{ rev: 0, role: "author", claude: "opus" }, "claude"],
    [{ rev: 0, role: "author", codex: "claude-opus-5-5" }, "codex"], [{ rev: 0, role: "author", codex: "turbo" }, "codex"],
    [{ rev: 0, role: "author", claude: "claude-opus-5-5", who: "owner" }, "不认识的字段"],
  ])("%j → 拒", (body, why) => {
    const r = parseRoleModelPatch(body);
    expect(typeof r).toBe("string");
    expect(r as string).toContain(why);
  });

  test("合法补丁原样收；codex:null = 照 Codex 配置", () => {
    expect(parseRoleModelPatch({ rev: 2, role: "pm-reviewer", codex: null })).toEqual({ rev: 2, role: "pm-reviewer", codex: null });
    expect(parseRoleModelPatch({ rev: 0, role: "author", claude: "claude-sonnet-5-5", codex: "high" }))
      .toEqual({ rev: 0, role: "author", claude: "claude-sonnet-5-5", codex: "high" });
  });
});

describe("保存（唯一写入口）", () => {
  test("按读到的 rev 改一格：rev+1，只动这一格", async () => {
    const p = fileIn(tmp());
    const r = await saveRoleModels({ rev: 0, role: "reviewer", codex: "xhigh" }, p);
    expect(r.ok).toBe(true);
    const t = JSON.parse(readFileSync(p, "utf8")) as RoleModelTable;
    expect(t.rev).toBe(1);
    expect(t.roles.reviewer).toEqual({ claude: "claude-opus-5-5", codex: "xhigh" });
    expect(t.roles.author).toEqual(defaultRoleModels().roles.author);
    expect(readRoleModels(p).status).toBe("ok");
  });

  test("rev 过期 = conflict，带回现表，不覆盖", async () => {
    const p = fileIn(tmp());
    await saveRoleModels({ rev: 0, role: "author", claude: "claude-sonnet-5-5" }, p);
    const before = readFileSync(p, "utf8");
    const r = await saveRoleModels({ rev: 0, role: "author", claude: "claude-haiku-5-5" }, p);
    expect(r).toMatchObject({ ok: false, code: "conflict", current: { rev: 1 } });
    expect(readFileSync(p, "utf8")).toBe(before);
  });

  test("锁被别人拿着 = busy，不裸写", async () => {
    const p = fileIn(tmp());
    const held = await acquireLock(`${p}.lock`, 1000);
    try {
      const r = await saveRoleModels({ rev: 0, role: "author", claude: "claude-sonnet-5-5" }, p);
      expect(r).toMatchObject({ ok: false, code: "busy" });
      expect(existsSync(p)).toBe(false);
    } finally { held?.release(); }
  }, 15_000);

  test("内容坏的文件：另存 .invalid-<ts> 后以默认表为底写入", async () => {
    const d = tmp(), p = fileIn(d);
    writeFileSync(p, "{bad");
    const r = await saveRoleModels({ rev: 0, role: "author", codex: "high" }, p, 123);
    expect(r).toMatchObject({ ok: true, replacedInvalid: expect.stringContaining("JSON") });
    expect(readFileSync(join(d, "role-model-settings.json.invalid-123"), "utf8")).toBe("{bad");
    expect(readRoleModels(p)).toMatchObject({ status: "ok", table: { rev: 1, roles: { author: { claude: "claude-opus-5-5", codex: "high" } } } });
  });

  test("读不了的文件：不写", async () => {
    const d = tmp(), p = fileIn(d);
    mkdirSync(p);
    const r = await saveRoleModels({ rev: 0, role: "author", codex: "high" }, p);
    expect(r).toMatchObject({ ok: false, code: "unreadable" });
    expect(readdirSync(d).sort()).toEqual(["role-model-settings.json"]);
  });

  test("迟到写者：A 提交前被暂停、锁过期被 B（另一个进程）回收并保存，A 恢复后被拒，B 的值原样保留", async () => {
    const p = fileIn(tmp());
    const mod = resolve("src/lib/role-model-settings.ts");
    const box: { b?: { ok: boolean; rev: number | null } } = {};
    const a = await saveRoleModels({ rev: 0, role: "author", claude: "claude-sonnet-5-5" }, p, Date.now(), { beforeCommit: () => {
      const old = new Date(Date.now() - 600_000);
      utimesSync(`${p}.lock`, old, old); // A 停在这里超过锁期限
      const r = Bun.spawnSync([process.execPath, "-e",
        `const m = await import(${JSON.stringify(mod)}); const r = await m.saveRoleModels({ rev: 0, role: "reviewer", codex: "high" }, ${JSON.stringify(p)});` +
        "console.log(JSON.stringify({ ok: r.ok, rev: r.table?.rev ?? null }));"], { stdout: "pipe", stderr: "pipe", env: testChildEnv() });
      box.b = JSON.parse(r.stdout.toString().trim());
    } });
    expect(box.b).toEqual({ ok: true, rev: 1 });
    expect(a).toMatchObject({ ok: false, code: "busy" });
    const t = readRoleModels(p);
    expect(t).toMatchObject({ status: "ok", table: { rev: 1, roles: { reviewer: { codex: "high" }, author: { claude: "claude-opus-5-5" } } } });
    expect(readdirSync(dirname(p)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  }, 30_000);

  test("两个进程同时按同一版保存：恰好一个成功，另一个 conflict 或 busy，文件是成功那个写的", async () => {
    const p = fileIn(tmp());
    const mod = resolve("src/lib/role-model-settings.ts");
    const run = (model: string) => Bun.spawn([process.execPath, "-e",
      `const m = await import(${JSON.stringify(mod)}); const r = await m.saveRoleModels({ rev: 0, role: "author", claude: ${JSON.stringify(model)} }, ${JSON.stringify(p)});` +
      "console.log(JSON.stringify({ ok: r.ok, code: r.code ?? null }));"], { stdout: "pipe", stderr: "pipe", env: testChildEnv() });
    const procs = [run("claude-sonnet-5-5"), run("claude-haiku-5-5")];
    const outs = await Promise.all(procs.map(async (x) => { await x.exited; return JSON.parse((await new Response(x.stdout).text()).trim()) as { ok: boolean; code: string | null }; }));
    expect(outs.filter((o) => o.ok)).toHaveLength(1);
    expect(outs.filter((o) => !o.ok).every((o) => o.code === "conflict" || o.code === "busy")).toBe(true);
    const t = readRoleModels(p);
    expect(t).toMatchObject({ status: "ok", table: { rev: 1 } });
    expect(["claude-sonnet-5-5", "claude-haiku-5-5"]).toContain(t.table.roles.author.claude);
  }, 30_000);
});
