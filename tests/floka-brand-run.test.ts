/**
 * BRAND1 的执行驱动（scripts/rename-floka/brand-run.ts）与允许表（brand-rules.json）。
 * 只在临时目录里造合成 git 仓库来跑，不扫真仓库：真仓库的执行由本卡交付时跑一次，结果在 brand-result.json。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { brandRuleIds, brandRuleSet, runBrand, stagingResidue } from "../scripts/rename-floka/brand-run.ts";
import bundled from "../scripts/rename-floka/codemod/rules.json";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

function git(repo: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

const FILES: Record<string, string> = {
  "README.md": "# Claudestra\n\n装好后运行 `claudestra pair`。Cross-Claudestra 协作见 docs。\n",
  "package.json": '{\n  "name": "claudestra",\n  "description": "Claudestra 编排器"\n}\n',
  "web/app/layout.tsx": 'export const metadata = { title: "Claudestra" }; // Claudestra 网页\nexport const A = () => <h1>CLAUDESTRA</h1>;\n',
  "web/lib/notify.ts": 'export const HINT = "只推「Claudestra · 类型」";\nexport const CLS = "cstra-bubble";\n',
  "src/app.ts": '// Claudestra 的入口\nexport const NAME = "Claudestra";\n',
  "desktop/src-tauri/tauri.conf.json": '{ "productName": "Claudestra", "identifier": "com.claudestra.desktop" }\n',
};

function synthRepo(): string {
  const repo = tmp("floka-brand-repo-");
  for (const [rel, body] of Object.entries(FILES)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), body);
  }
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return repo;
}

describe("允许表", () => {
  test("自带 history / protocol 规则原样在前，自带 brand 规则不用；本卡 brand 规则都写明文件，不碰 src / tests", () => {
    const set = brandRuleSet();
    const own = (bundled.rules as { id: string; class: string }[]).filter((r) => r.class !== "brand").map((r) => r.id);
    expect(set.rules.slice(0, own.length).map((r) => r.id)).toEqual(own);
    expect(set.rules.some((r) => r.id.startsWith("brand.display"))).toBe(false);
    for (const r of set.rules.filter((x) => x.class === "brand")) {
      expect(r.files!.length).toBeGreaterThan(0);
      expect(r.files!.some((g) => /^(src|tests|scripts)\//.test(g))).toBe(false);
    }
    expect(brandRuleIds(set).every((id) => id.startsWith("brand1."))).toBe(true);
  });

  test("overlay 格式不对整张作废", () => {
    expect(() => brandRuleSet({ format: "x", version: 1, rules: [] })).toThrow("overlay");
  });
});

describe("执行", () => {
  test("observe 只出摘要，不写工作区", () => {
    const repo = synthRepo();
    const r = runBrand({ repo, ref: "HEAD", mode: "observe" }) as { plan: { ok: boolean; brand: Record<string, unknown> } };
    expect(r.plan.ok).toBe(true);
    expect(Object.keys(r.plan.brand).length).toBeGreaterThan(0);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe(FILES["README.md"]!);
  });

  test("off 什么都不做", () => {
    expect(runBrand({ repo: synthRepo(), ref: "HEAD", mode: "off" })).toEqual({ mode: "off", skipped: true });
  });

  test("on：范围内的品牌字样换掉，命令名 / 包身份 / 协议 / 范围外 / App 身份 / 别处发出的文字不动；残留扫描归零", () => {
    const repo = synthRepo();
    const result = join(tmp("floka-brand-out-"), "brand-result.json");
    const r = runBrand({ repo, ref: "HEAD", mode: "on", result }) as {
      applied: { written: string[] };
      residue: { ok: boolean; totals: { brand: number; rejected: number } };
    };
    expect(r.applied.written.sort()).toEqual(["README.md", "package.json", "web/app/layout.tsx"]);
    expect(r.residue.ok).toBe(true);
    expect(r.residue.totals).toMatchObject({ brand: 0, rejected: 0 });
    const read = (rel: string) => readFileSync(join(repo, rel), "utf8");
    expect(read("README.md")).toBe("# Floka\n\n装好后运行 `claudestra pair`。Cross-Floka 协作见 docs。\n");
    // 根包名是 src/lib/conv-ignored-build-artifacts.ts 认的仓库身份，不改；描述照改
    expect(read("package.json")).toBe('{\n  "name": "claudestra",\n  "description": "Floka 编排器"\n}\n');
    expect(read("web/app/layout.tsx")).toBe('export const metadata = { title: "Floka" }; // Floka 网页\nexport const A = () => <h1>FLOKA</h1>;\n');
    for (const rel of ["web/lib/notify.ts", "src/app.ts", "desktop/src-tauri/tauri.conf.json"]) expect(read(rel)).toBe(FILES[rel]!);
    expect(JSON.parse(readFileSync(result, "utf8")).residue.ok).toBe(true);
  });

  test("工作区和 ref 不一致时整批不拷回", () => {
    const repo = synthRepo();
    writeFileSync(join(repo, "README.md"), "# Claudestra 本地改过\n");
    expect(() => runBrand({ repo, ref: "HEAD", mode: "on" })).toThrow("工作区和 ref 不一致");
    expect(readFileSync(join(repo, "package.json"), "utf8")).toBe(FILES["package.json"]!);
  });
});

test("暂存残留扫描只列 .<别名>.floka-unlink-<uuid>，不删", () => {
  const dir = tmp("floka-brand-runtime-");
  const left = join(dir, ".floka.floka-unlink-0b4a3f8e-2c1d-4e5f-9a7b-1c2d3e4f5a6b");
  mkdirSync(left);
  writeFileSync(join(dir, "floka.floka-unlink-not-hidden"), "");
  expect(stagingResidue(dir)).toEqual({ scanned: dir, found: [left] });
  expect(stagingResidue(join(dir, "missing"))).toEqual({ scanned: join(dir, "missing"), found: [] });
});
