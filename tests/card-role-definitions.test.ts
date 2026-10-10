/**
 * ROLE1 card role definitions (src/lib/card-role-definitions.ts): the repo's .claude/agents/card-*.md are well formed and pin
 * claude-opus-5-5; applyCardRole turns them into argv the real `manager create` parser (manager/create-args.ts) reads as
 * model / disallowedTools / purpose; anything broken is a diagnosis and no create, never a fallback.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCardRole, CARD_DEFAULT_MODEL, CARD_ROLE_DIR, CARD_ROLES, cardRoleCreate, cardRoleIo, cardRoleManager, DUTIES_LIMIT, loadCardRole, READ_ONLY_FLOOR,
  type CardRole,
} from "../src/lib/card-role-definitions.js";
import { DISALLOWED_PRESETS, resolveDisallowed } from "../src/lib/claude-launch.js";
import { parseCreateArgs, type CreateArgs } from "../src/manager/create-args.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

/** A synthetic definitions dir: the repo's four files copied, then edited per test. */
function defsDir(edit: Partial<Record<CardRole, (md: string) => string | null>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "role1-defs-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const role of CARD_ROLES) {
    const md = readFileSync(join(CARD_ROLE_DIR, `card-${role}.md`), "utf8");
    const out = edit[role] ? edit[role]!(md) : md;
    if (out !== null) writeFileSync(join(dir, `card-${role}.md`), out);
  }
  return dir;
}

const authorArgs = ["create", "task-ap-a", "/wt/ap-a", "--purpose", "ap-a 作者", "--task", "ap-a", "--card", "ap-a", "--card-role", "author",
  "--effort", "high", "--project", "p"];
const reviewerArgs = ["create", "agent-rv-t1", "/wt/rv-t1", "--purpose", "T1 跨模型对抗式审查（调度引擎建）", "--project", "p", "--task", "T1 审查",
  "--card", "T1", "--card-role", "reviewer"];
const otherArgs = reviewerArgs.map((a) => a === "reviewer" ? "other" : a);
const parsed = (args: string[]): CreateArgs => {
  const c = parseCreateArgs(args.slice(1));
  if ("error" in c) throw new Error(c.error);
  return c;
};
const applied = (args: string[], opts = {}) => {
  const r = applyCardRole(args, opts);
  if ("error" in r) throw new Error(r.error);
  return r.args;
};

describe("repo definitions", () => {
  test("all four load, pin claude-opus-5-5, carry the LIFE1 card-role; review roles are read-only with the floor, the author is not", () => {
    const defs = CARD_ROLES.map((r) => loadCardRole(r));
    for (const d of defs) {
      if ("error" in d) throw new Error(d.error);
      expect(d.model).toBe(CARD_DEFAULT_MODEL);
      expect(d.name).toBe(`card-${d.role}`);
      expect(d.body.length).toBeGreaterThan(20);
    }
    const by = Object.fromEntries(defs.map((d) => ["error" in d ? "" : d.role, d])) as Record<CardRole, Exclude<ReturnType<typeof loadCardRole>, { error: string }>>;
    expect([by.author.cardRole, by.reviewer.cardRole, by["adversarial-reviewer"].cardRole, by["pm-reviewer"].cardRole]).toEqual(["author", "reviewer", "reviewer", "other"]);
    expect(by.author).toMatchObject({ readOnly: false, disallowedTools: [] });
    for (const r of ["reviewer", "adversarial-reviewer", "pm-reviewer"] as const) {
      expect(by[r].readOnly).toBe(true);
      expect(by[r].disallowedTools).toEqual(expect.arrayContaining([...READ_ONLY_FLOOR]));
    }
  });

  test("definitions only restrict: no allow-list, permission mode or tool grant fields", () => {
    for (const r of CARD_ROLES) {
      const fm = readFileSync(join(CARD_ROLE_DIR, `card-${r}.md`), "utf8").split("\n---")[0];
      expect(fm).not.toMatch(/^(tools|allowedTools|permissionMode|permission-mode|mode|preset):/m);
    }
  });
});

describe("applyCardRole → real manager create parser", () => {
  test("author: --model claude-opus-5-5 and duties in purpose; default tool preset untouched", () => {
    const c = parsed(applied(authorArgs));
    expect(c.model).toBe("claude-opus-5-5");
    expect(c.perms).toEqual({ preset: undefined, disallowedRaw: undefined });
    expect(c.purpose).toStartWith("ap-a 作者\n\n【卡片角色 card-author】\n");
    expect(c.card).toEqual({ taskId: "ap-a", role: "author" });
    expect(c.effort).toBe("high");
  });

  test("reviewer: model, a hard --disallowed list (default preset + definition) the launcher resolves, duties", () => {
    const c = parsed(applied(reviewerArgs));
    expect(c.model).toBe("claude-opus-5-5");
    const rules = resolveDisallowed({ preset: c.perms.preset, raw: c.perms.disallowedRaw });
    expect(rules).toEqual(expect.arrayContaining([...DISALLOWED_PRESETS.default, ...READ_ONLY_FLOOR]));
    expect(c.purpose).toContain("【卡片角色 card-reviewer】");
    expect(c.card).toEqual({ taskId: "T1", role: "reviewer" });
  });

  test("adversarial and pm-reviewer by explicit role, each against its own LIFE1 card-role", () => {
    expect(parsed(applied(reviewerArgs, { role: "adversarial-reviewer" })).purpose).toContain("card-adversarial-reviewer");
    const other = reviewerArgs.map((a) => a === "reviewer" ? "other" : a);
    expect(parsed(applied(other, { role: "pm-reviewer" })).card).toEqual({ taskId: "T1", role: "other" });
    expect(applyCardRole(reviewerArgs, { role: "pm-reviewer" })).toEqual({ error: expect.stringContaining("登记为 --card-role other，这次 create 带的是 reviewer") });
    expect(applyCardRole(other, { role: "reviewer" as CardRole })).toMatchObject({ error: expect.stringContaining("没有建会话") });
  });

  test("an explicit model is kept, in either spelling", () => {
    expect(parsed(applied([...authorArgs, "--model", "claude-sonnet-5"])).model).toBe("claude-sonnet-5");
    expect(parsed(applied([...authorArgs, "--model=haiku"])).model).toBe("haiku");
  });

  test("a blank or flag-like explicit model is refused, not taken as \"explicit\" (the launcher would drop it and fall back)", async () => {
    for (const tail of [["--model", ""], ["--model", "  "], ["--model="], ["--model= "], ["--model"], ["--model", "--effort"]]) {
      for (const args of [[...reviewerArgs, ...tail], [...authorArgs, ...tail]]) {
        expect(applyCardRole(args)).toEqual({ error: expect.stringContaining("无效的 --model") });
        const calls: string[][] = [];
        expect(await cardRoleCreate(async (...a: string[]) => { calls.push(a); return { ok: true }; })(...args)).toMatchObject({ ok: false });
        expect(calls).toEqual([]);
      }
    }
  });

  test("other families, non-card creates, non-create commands and an unnamed --card-role other pass unchanged", () => {
    for (const args of [[...reviewerArgs, "--runtime", "codex", "--transport", "acp"], [...authorArgs, "--runtime=pi"],
      authorArgs.filter((a, i) => i < 9 || i > 10), ["ledger", "show", "--card-role", "author"], reviewerArgs.map((a) => a === "reviewer" ? "other" : a)]) {
      expect(applyCardRole(args)).toEqual({ args });
    }
    expect(parsed(applied([...authorArgs, "--runtime", "claude-code"])).model).toBe(CARD_DEFAULT_MODEL);
  });

  test("free text that looks like a flag is not read as one", () => {
    const args = ["create", "x", "/d", "--purpose", "--model", "--card", "T1", "--card-role", "author"];
    const c = parsed(applied(args));
    expect(c.model).toBe(CARD_DEFAULT_MODEL);
    expect(c.purpose).toStartWith("--model\n\n");
    expect(parsed(applied(["create", "x", "/d", "--purpose=审 --model x", "--card", "T1", "--card-role", "author"])).purpose).toStartWith("审 --model x\n\n【");
  });

  test("a create that already carries another tool boundary is refused for a read-only role, not overridden or widened", () => {
    expect(applyCardRole([...reviewerArgs, "--preset", "default"])).toMatchObject({ error: expect.stringContaining("不覆盖也不放宽") });
    expect(applyCardRole([...reviewerArgs, "--disallowed=Bash(rm:*)"])).toMatchObject({ error: expect.stringContaining("--disallowed=") });
  });
});

describe("broken definitions stop the create with a diagnosis (no fallback model, no silent read-write)", () => {
  const cases: [string, Partial<Record<CardRole, (md: string) => string | null>>, string][] = [
    ["missing file", { reviewer: () => null }, "读不到角色定义"],
    ["no frontmatter", { reviewer: (md) => md.replace(/^---\n/, "") }, "缺 frontmatter"],
    ["alias model", { reviewer: (md) => md.replace("model: claude-opus-5-5", "model: opus") }, "完整的 Claude 模型 id"],
    ["non-Claude model", { reviewer: (md) => md.replace("model: claude-opus-5-5", "model: gpt-5.5") }, "完整的 Claude 模型 id"],
    ["empty model", { reviewer: (md) => md.replace("model: claude-opus-5-5", "model:") }, "完整的 Claude 模型 id"],
    ["wrong name", { reviewer: (md) => md.replace("name: card-reviewer", "name: card-author") }, "name 应为 card-reviewer"],
    ["bad card-role", { reviewer: (md) => md.replace("card-role: reviewer", "card-role: pm") }, "card-role 应为 reviewer"],
    ["identity swap: adversarial registers as other", { "adversarial-reviewer": (md) => md.replace("card-role: reviewer", "card-role: other") }, "card-role 应为 reviewer"],
    ["identity swap: pm-reviewer registers as reviewer", { "pm-reviewer": (md) => md.replace("card-role: other", "card-role: reviewer") }, "card-role 应为 other"],
    ["read-only missing floor", { reviewer: (md) => md.replace("Write(./**), ", "") }, "缺 Write(./**)"],
    ["read-only keeps Bash", { reviewer: (md) => md.replace("disallowedTools: Bash, ", "disallowedTools: ") }, "缺 Bash"],
    ["read-only unset", { reviewer: (md) => md.replace("read-only: true\n", "") }, "read-only 应为 true"],
    ["read-only flipped to false with the boundary deleted", { reviewer: (md) => md.replace("read-only: true", "read-only: false").replace(/^disallowedTools:.*\n/m, "") },
      "read-only 应为 true"],
    ["adversarial flipped to read-write", { "adversarial-reviewer": (md) => md.replace("read-only: true", "read-only: false") }, "read-only 应为 true"],
    ["pm-reviewer boundary deleted", { "pm-reviewer": (md) => md.replace(/^disallowedTools:.*\n/m, "") }, "缺 Bash"],
    ["author flipped to read-only", { author: (md) => md.replace("read-only: false", "read-only: true") }, "read-only 应为 false"],
    ["bad rule", { reviewer: (md) => md.replace("NotebookEdit(./**)", "NotebookEdit(./**") }, "disallowedTools"],
    ["duties too long to survive the launcher", { author: (md) => md.trimEnd() + "\n" + "长".repeat(DUTIES_LIMIT) + "\n" }, "启动时会被截断"],
    ["empty body", { author: (md) => md.replace(/\n---\n[\s\S]*$/, "\n---\n") }, "正文"],
  ];
  for (const [name, edit, msg] of cases) {
    test(name, async () => {
      const dir = defsDir(edit);
      const [args, role] = edit.author ? [authorArgs, undefined] : edit["pm-reviewer"] ? [otherArgs, "pm-reviewer" as const]
        : [reviewerArgs, edit["adversarial-reviewer"] ? "adversarial-reviewer" as const : undefined];
      const r = applyCardRole(args, { dir, role });
      expect(r).toEqual({ error: expect.stringContaining(msg) });
      expect((r as { error: string }).error).toContain("没有建会话");
      const calls: string[][] = [];
      const create = async (...a: string[]): Promise<Record<string, unknown>> => { calls.push(a); return { ok: true }; };
      expect(await cardRoleCreate(create, { dir, role })(...args))
        .toEqual({ ok: false, error: (r as { error: string }).error });
      expect(await cardRoleManager(async (a: string[]) => { calls.push(a); return { ok: true }; }, { dir, role })(args)).toMatchObject({ ok: false });
      expect(calls).toEqual([]);
    });
  }

  test("unknown role key", () => {
    expect(applyCardRole(authorArgs, { role: "pm" as CardRole })).toEqual({ error: expect.stringContaining("没有卡片角色 \"pm\"") });
  });
});

describe("adapters", () => {
  test("the create result (lease-lost, registration failure) passes back unchanged; one call per create", async () => {
    for (const result of [{ ok: false, code: "lease-lost", error: "lease" }, { ok: false, error: "台账已预留登记，但…（留给 PM）" }, { ok: true, agent: "agent-rv-t1" }]) {
      const calls: string[][] = [];
      expect(await cardRoleCreate(async (...a: string[]) => { calls.push(a); return result; })(...reviewerArgs)).toBe(result);
      expect(calls).toHaveLength(1);
      expect(parsed(calls[0]).model).toBe(CARD_DEFAULT_MODEL);
    }
  });

  test("cardRoleIo reads the caller's current manager on every call and keeps the timeout", async () => {
    const seen: [string, number | undefined][] = [];
    const io = { attempt: "x", manager: async (a: string[], t?: number) => { seen.push(["first", t]); return { a }; } };
    const wrapped = cardRoleIo(io);
    await wrapped.manager(authorArgs, 5);
    io.manager = async (a: string[], t?: number) => { seen.push(["second", t]); return { a }; };
    const r = await wrapped.manager(authorArgs, 7) as { a: string[] };
    expect(seen).toEqual([["first", 5], ["second", 7]]);
    expect(parsed(r.a).model).toBe(CARD_DEFAULT_MODEL);
    expect(wrapped.attempt).toBe("x");
  });
});

describe("nesting", () => {
  test("applying twice (runStart nested in runLocalStart) is a no-op the second time, for every role", () => {
    for (const [args, role] of [[authorArgs, undefined], [reviewerArgs, undefined], [reviewerArgs, "adversarial-reviewer"],
      [reviewerArgs.map((a) => a === "reviewer" ? "other" : a), "pm-reviewer"], [authorArgs.filter((_, i) => i !== 3 && i !== 4), undefined]] as const) {
      const once = applied([...args], { role });
      expect(applied(once, { role })).toEqual(once);
    }
  });

  test("a look-alike purpose without the model or the exact boundary is still applied (and conflicts stay refused)", () => {
    const fake = ["create", "x", "/d", "--purpose", "x\n\n【卡片角色 card-author】\n", "--card", "T1", "--card-role", "author"];
    expect(parsed(applied(fake)).model).toBe(CARD_DEFAULT_MODEL);
    const once = applied(reviewerArgs);
    const i = once.indexOf("--disallowed");
    expect(applyCardRole([...once.slice(0, i + 1), "Write", ...once.slice(i + 2)])).toMatchObject({ error: expect.stringContaining("不覆盖也不放宽") });
  });

  test("family chosen by the entry: a non-Claude family passes unchanged even before its --runtime is appended", () => {
    expect(applyCardRole(authorArgs, { family: "codex" })).toEqual({ args: authorArgs });
    expect(parsed(applied(authorArgs, { family: "claude" })).model).toBe(CARD_DEFAULT_MODEL);
  });
});
