import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../src/lib/principals.js";
import type { CodexModel } from "../src/lib/codex-catalog.js";
import { codexDefaultsRoute, type CodexDefaultsDeps } from "../src/bridge/runtime-settings-routes.ts";
import { writeCodexDefaults, type CodexConfigWriter } from "../src/lib/codex-config-write.ts";
import { sandboxDeniedRoute } from "../src/bridge/sandbox-routes.ts";
import { writeTextAtomicSync } from "../src/lib/state-file.ts";

const OWNER: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z", manage: true, credential: "dev_o1" };
const GUEST: Principal = { id: "guest:1", role: "external", name: "g", agents: ["worker"], createdAt: "2026-01-01T00:00:00Z", manage: false, credential: "dev_g1" };

const CATALOG: CodexModel[] = [
  { id: "gpt-5.5", name: "GPT-5.5", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", contextWindow: null },
  { id: "gpt-5.5-mini", name: "GPT-5.5 mini", efforts: ["low", "medium"], defaultEffort: "low", contextWindow: null },
];
const ORIGINAL = `# 手写
model = "gpt-5.5"
model_reasoning_effort = "xhigh"

[mcp_servers.x]
command = "bun"
`;

let home: string;
let cfg: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codex-defaults-"));
  mkdirSync(join(home, ".codex"));
  cfg = join(home, ".codex", "config.toml");
  writeFileSync(cfg, ORIGINAL, { mode: 0o640 });
  chmodSync(cfg, 0o640);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const deps = (over: Partial<CodexDefaultsDeps> = {}): CodexDefaultsDeps => ({ home, catalog: async () => CATALOG, ...over });
const req = (method: string, body?: unknown) =>
  new Request("http://x/api/v1/config/codex-defaults", { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
const backups = () => readdirSync(join(home, ".codex")).filter((f) => f.startsWith("config.toml.bak-"));

describe("GET/PUT /config/codex-defaults", () => {
  test("非全权 403，文件不动", async () => {
    expect((await codexDefaultsRoute(req("GET"), GUEST, deps())).status).toBe(403);
    expect((await codexDefaultsRoute(req("PUT", { model: "gpt-5.5-mini" }), GUEST, deps())).status).toBe(403);
    expect(readFileSync(cfg, "utf8")).toBe(ORIGINAL);
  });

  test("GET 返回顶层两项 + 模型目录；没写返回 null", async () => {
    const j: any = await (await codexDefaultsRoute(req("GET"), OWNER, deps())).json();
    expect(j).toMatchObject({ ok: true, model: "gpt-5.5", effort: "xhigh", catalogOk: true, codexDefault: { model: "gpt-5.5", effort: "medium" } });
    expect(j.models.map((m: CodexModel) => m.id)).toEqual(["gpt-5.5", "gpt-5.5-mini"]);
    rmSync(cfg);
    expect(await (await codexDefaultsRoute(req("GET"), OWNER, deps())).json()).toMatchObject({ model: null, effort: null });
  });

  test("目录外的模型 / 模型不支持的档位 / 非字符串 → 400，文件不动、不留备份", async () => {
    for (const body of [{ model: "gpt-9" }, { effort: "ultra" }, { model: "gpt-5.5-mini", effort: "high" }, { model: 3 }, {}, { model: "a\nb" }]) {
      const r = await codexDefaultsRoute(req("PUT", body), OWNER, deps());
      expect(r.status).toBe(400);
    }
    expect(readFileSync(cfg, "utf8")).toBe(ORIGINAL);
    expect(backups()).toEqual([]);
  });

  test("PUT 只改两行、留备份、保留权限；GET 读回新值", async () => {
    const r = await codexDefaultsRoute(req("PUT", { model: "gpt-5.5", effort: "high" }), OWNER, deps());
    expect(await r.json()).toMatchObject({ ok: true, model: "gpt-5.5", effort: "high", backedUp: true });
    expect(readFileSync(cfg, "utf8")).toBe(ORIGINAL.replace('"xhigh"', '"high"'));
    expect(statSync(cfg).mode & 0o777).toBe(0o640);
    expect(backups().length).toBe(1);
    expect(readFileSync(join(home, ".codex", backups()[0]), "utf8")).toBe(ORIGINAL);
    expect(await (await codexDefaultsRoute(req("GET"), OWNER, deps())).json()).toMatchObject({ model: "gpt-5.5", effort: "high" });
  });

  test("只换模型、原档位新模型不支持 → 档位清掉回到新模型默认", async () => {
    const j: any = await (await codexDefaultsRoute(req("PUT", { model: "gpt-5.5-mini" }), OWNER, deps())).json();
    expect(j).toMatchObject({ ok: true, model: "gpt-5.5-mini", effort: null, effortCleared: true });
    expect(readFileSync(cfg, "utf8")).toBe(ORIGINAL.replace('"gpt-5.5"', '"gpt-5.5-mini"').replace('model_reasoning_effort = "xhigh"\n', ""));
  });

  test("清空（null / 空串）→ 删行", async () => {
    const j: any = await (await codexDefaultsRoute(req("PUT", { model: null, effort: "" }), OWNER, deps())).json();
    expect(j).toMatchObject({ ok: true, model: null, effort: null });
    expect(readFileSync(cfg, "utf8")).toBe("# 手写\n\n[mcp_servers.x]\ncommand = \"bun\"\n");
  });

  test("目录拉不到：不让改模型（503），档位按 Codex 全集校验仍可改", async () => {
    const off = deps({ catalog: async () => null });
    expect((await codexDefaultsRoute(req("PUT", { model: "gpt-5.5" }), OWNER, off)).status).toBe(503);
    expect((await codexDefaultsRoute(req("PUT", { effort: "low" }), OWNER, off)).status).toBe(200);
  });

  test("写入失败 → 5xx，原文件不被截断，备份已生成", async () => {
    const boom: CodexConfigWriter = (path) => {
      writeFileSync(`${path}.partial.tmp`, "model = ");
      throw new Error("disk full");
    };
    const r = await codexDefaultsRoute(req("PUT", { effort: "low" }), OWNER, deps({ write: boom }));
    expect(r.status).toBe(500);
    expect(readFileSync(cfg, "utf8")).toBe(ORIGINAL);
    expect(backups().length).toBe(1);
  });

  test("沙箱把 PUT 列为改全局配置，GET 不拦", () => {
    expect(sandboxDeniedRoute("PUT", "/config/codex-defaults")?.feature).toContain("~/.codex/config.toml");
    expect(sandboxDeniedRoute("GET", "/config/codex-defaults")).toBeNull();
  });
});

describe("认不出的写法 / 并发（验收 7、8）", () => {
  test("引号转义键名、多行字符串：effort-only 按文件里实际的模型校验", async () => {
    for (const toml of ['"mod\\u0065l" = "gpt-5.5-mini"\n[t]\n', 'model = """\ngpt-5.5-mini"""\n[t]\n']) {
      writeFileSync(cfg, toml);
      expect(await (await codexDefaultsRoute(req("GET"), OWNER, deps())).json()).toMatchObject({ model: "gpt-5.5-mini" });
      const r = await codexDefaultsRoute(req("PUT", { effort: "high" }), OWNER, deps());
      expect(r.status).toBe(400); // mini 不支持 high
      expect(readFileSync(cfg, "utf8")).toBe(toml);
      expect((await codexDefaultsRoute(req("PUT", { effort: "low" }), OWNER, deps())).status).toBe(200);
      expect(Bun.TOML.parse(readFileSync(cfg, "utf8"))).toMatchObject({ model_reasoning_effort: "low", t: {} });
    }
  });

  test("认不出的写法 → 422，文件不动、无备份", async () => {
    const toml = "model.x = 1\n[t]\n";
    writeFileSync(cfg, toml);
    expect((await codexDefaultsRoute(req("GET"), OWNER, deps())).status).toBe(422);
    const r = await codexDefaultsRoute(req("PUT", { effort: "low" }), OWNER, deps());
    expect(r.status).toBe(422);
    expect(readFileSync(cfg, "utf8")).toBe(toml);
    expect(backups()).toEqual([]);
  });

  test("两个 PUT 交错：A（effort=xhigh）停在等目录上，B（model=mini）先写成 → A 409，不会写出 mini+xhigh", async () => {
    writeFileSync(cfg, ORIGINAL.replace('"xhigh"', '"high"'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = deps({ catalog: async () => { await gate; return CATALOG; } });
    const a = codexDefaultsRoute(req("PUT", { effort: "xhigh" }), OWNER, slow);
    const b = await codexDefaultsRoute(req("PUT", { model: "gpt-5.5-mini" }), OWNER, deps());
    expect(await b.json()).toMatchObject({ ok: true, model: "gpt-5.5-mini", effort: null, effortCleared: true });
    release();
    const ra = await a;
    expect(ra.status).toBe(409);
    const final = Bun.TOML.parse(readFileSync(cfg, "utf8")) as Record<string, unknown>;
    expect(final.model).toBe("gpt-5.5-mini");
    expect(final.model_reasoning_effort).toBeUndefined();
  });

  test("rename 之后别的进程追加合法的 [projects] → 保留磁盘内容（不回滚、不删），409", async () => {
    const extra = '\n[projects."/x"]\ntrust_level = "trusted"\n';
    const thenAppend: CodexConfigWriter = (path, text, opts) => {
      writeTextAtomicSync(path, text, opts);
      appendFileSync(path, extra); // 原子写返回之后，另一个进程的合法修改
    };
    const r = await codexDefaultsRoute(req("PUT", { effort: "low" }), OWNER, deps({ write: thenAppend }));
    expect(r.status).toBe(409);
    expect(readFileSync(cfg, "utf8")).toBe(ORIGINAL.replace('"xhigh"', '"low"') + extra);
  });

  test("原来没有文件、rename 之后被别人改了 → 也不删", () => {
    rmSync(cfg);
    const thenAppend: CodexConfigWriter = (path, text, opts) => {
      writeTextAtomicSync(path, text, opts);
      appendFileSync(path, "x = 1\n");
    };
    expect(() => writeCodexDefaults(home, { model: "m" }, { write: thenAppend })).toThrow("已保留磁盘上的内容");
    expect(readFileSync(cfg, "utf8")).toBe('model = "m"\nx = 1\n');
  });
});

describe("writeCodexDefaults 原子性", () => {
  test("rename 之前原文件被别人改过 → 不提交，别人的改动保留", () => {
    const sneaky: CodexConfigWriter = (path, text, opts) => {
      writeFileSync(path, ORIGINAL + "\n[projects.\"/x\"]\ntrust_level = \"trusted\"\n");
      if (opts?.commitIf && !opts.commitIf()) throw new Error("提交前核验没通过");
      writeFileSync(path, text);
    };
    expect(() => writeCodexDefaults(home, { model: "gpt-5.5-mini" }, { write: sneaky })).toThrow("刚被别处改过");
    expect(readFileSync(cfg, "utf8")).toContain("[projects.");
  });

  test("文件不存在 → 新建（600），没有备份；没变化不写", () => {
    rmSync(cfg);
    expect(writeCodexDefaults(home, { model: "m" }).backup).toBeNull();
    expect(readFileSync(cfg, "utf8")).toBe('model = "m"\n');
    expect(statSync(cfg).mode & 0o777).toBe(0o600);
    expect(writeCodexDefaults(home, { model: "m" }).changed).toBe(false);
    expect(backups()).toEqual([]);
  });

  test("备份只留最近 5 份", () => {
    for (let i = 0; i < 8; i++) writeCodexDefaults(home, { model: `m${i}` }, { now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
    const b = backups().sort();
    expect(b.length).toBe(5);
    expect(b[0]).toContain("00-00-03");
    expect(existsSync(cfg)).toBe(true);
  });
});
