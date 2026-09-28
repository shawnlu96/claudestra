/** src/lib/project-dirs.ts：项目目录只收绝对路径、一个目录只归一个项目（已存在的按 realpathSync.native 比，不存在的按规范化路径比） */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirKey, validateProjectDirs } from "../src/lib/project-dirs.js";
import type { ProjectDef } from "../src/lib/projects.js";
import { DICT } from "../web/lib/i18n-dict";

const HOME = process.env.HOME || "";
const proj = (id: string, dirs: string[]): ProjectDef => ({ id, name: id, dirs, createdAt: "" });
const err = (r: ReturnType<typeof validateProjectDirs>) => (r.ok ? null : r.error);

describe("validateProjectDirs：只收绝对路径，报错给出怎么写", () => {
  test("~ / $HOME / ${HOME} / 别的环境变量 / 相对路径都拒绝", () => {
    expect(err(validateProjectDirs(["~/repos/x"], [], "p"))).toContain(`请写成「${HOME}/repos/x」`);
    expect(err(validateProjectDirs(["$HOME/repos/x"], [], "p"))).toContain(`请写成「${HOME}/repos/x」`);
    expect(err(validateProjectDirs(["${HOME}/repos/x"], [], "p"))).toContain(`请写成「${HOME}/repos/x」`);
    expect(err(validateProjectDirs(["$WORK/x"], [], "p"))).toContain("环境变量");
    expect(err(validateProjectDirs(["~other/x"], [], "p"))).toContain("~用户名"); // 不能拼成 $HOME + "other/x"
    expect(validateProjectDirs(["~"], [], "p")).toMatchObject({ ok: false, tpl: expect.stringContaining("{fix}"), params: { dir: "~", fix: HOME } });
    expect(err(validateProjectDirs(["/abs/ok", "repos/x"], [], "p", "/Users/me"))).toContain("请写成绝对路径，例如「/Users/me/repos/x」");
  });
  test("绝对路径：去尾斜杠、/./ 和 //，同一项目内重复的去掉；目录不存在也收（可以先登记再 clone）", () => {
    expect(validateProjectDirs(["/no/such/a/", "/no/./such//a", " /no/such/b "], [], "p")).toEqual({ ok: true, dirs: ["/no/such/a", "/no/such/b"] });
  });
});

describe("validateProjectDirs：两个项目不能登记同一个目录", () => {
  test("不存在的目录按规范化后的绝对路径比；编辑自己的项目不算撞", () => {
    const projects = [proj("a", ["/no/such/repo"]), proj("b", ["/other"])];
    expect(err(validateProjectDirs(["/no/such/repo/"], projects, "b"))).toContain("已登记在项目 a 下");
    expect(err(validateProjectDirs(["/no/./such/repo"], projects, "c"))).toContain("project-merge");
    expect(validateProjectDirs(["/no/such/repo"], projects, "a")).toMatchObject({ ok: true });
    expect(validateProjectDirs(["/no/such/repo2"], projects, "b")).toMatchObject({ ok: true });
  });
  test("已存在的目录按真实路径比：symlink 指过去的算同一个", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pdirs-")));
    mkdirSync(join(root, "repo"));
    symlinkSync(join(root, "repo"), join(root, "link"));
    expect(err(validateProjectDirs([join(root, "link")], [proj("a", [join(root, "repo")])], "b"))).toContain("已登记在项目 a 下");
  });
  test("已存在的目录大小写不同（macOS 默认大小写不敏感）按同一个比；文件系统区分大小写时跳过", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pdirs-case-")));
    mkdirSync(join(root, "Repos"));
    if (!existsSync(join(root, "repos"))) return; // 区分大小写的文件系统（CI 的 Linux）：两个本来就是不同目录
    expect(dirKey(join(root, "repos"))).toBe(join(root, "Repos"));
    expect(err(validateProjectDirs([join(root, "repos")], [proj("a", [join(root, "Repos")])], "b"))).toContain("已登记在项目 a 下");
  });
});

test("报错模板（project-dirs.ts / project-guard.ts）在网页英文词表里都有译文，占位符一致", () => {
  const strip = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const tpls = ["../src/lib/project-dirs.ts", "../src/manager/project-guard.ts"].flatMap((f) =>
    [...strip(f).matchAll(/(?:fail\(|const tpl = )"([^"\n]+)"/g)].map((m) => m[1]),
  );
  expect(tpls.length).toBe(7);
  const holes = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const t of tpls) {
    expect(DICT[t], t).toBeString();
    expect(holes(DICT[t]), t).toEqual(holes(t));
  }
});
