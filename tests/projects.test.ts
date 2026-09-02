import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readProjects,
  writeProjects,
  resolveProjectForDir,
  slugifyProjectId,
  normalizeDir,
  PROJECT_ID_RE,
  type ProjectDef,
} from "../src/lib/projects.js";

const HOME = process.env.HOME || "";

function proj(id: string, dirs: string[]): ProjectDef {
  return { id, name: id, dirs, createdAt: "2026-08-28T00:00:00Z" };
}

describe("normalizeDir", () => {
  test("展开 ~ 前缀", () => {
    expect(normalizeDir("~/repos/x")).toBe(`${HOME}/repos/x`);
  });
  test("去尾斜杠(保留根)", () => {
    expect(normalizeDir("/a/b/")).toBe("/a/b");
    expect(normalizeDir("/a/b///")).toBe("/a/b");
    expect(normalizeDir("/")).toBe("/");
  });
});

describe("resolveProjectForDir", () => {
  const projects = [
    proj("qingniao", ["/r/qingniao/miniapp", "/r/qingniao/backend"]),
    proj("mono", ["/r/qingniao"]),
    proj("other", ["/r/other"]),
  ];
  test("精确命中", () => {
    expect(resolveProjectForDir(projects, "/r/qingniao/backend")?.id).toBe("qingniao");
  });
  test("子目录命中,且多命中时取最长(最具体)的 dir", () => {
    // /r/qingniao/miniapp/src 同时在 mono(/r/qingniao) 与 qingniao(/r/qingniao/miniapp) 下
    expect(resolveProjectForDir(projects, "/r/qingniao/miniapp/src")?.id).toBe("qingniao");
    // 只在 mono 下
    expect(resolveProjectForDir(projects, "/r/qingniao/docs")?.id).toBe("mono");
  });
  test("前缀相似但不是路径边界的不命中", () => {
    expect(resolveProjectForDir(projects, "/r/other-stuff")).toBeNull();
  });
  test("无命中返回 null", () => {
    expect(resolveProjectForDir(projects, "/elsewhere")).toBeNull();
  });
  test("尾斜杠/~ 两侧都归一", () => {
    const ps = [proj("h", ["~/repos/x"])];
    expect(resolveProjectForDir(ps, `${HOME}/repos/x/sub/`)?.id).toBe("h");
  });
  test("傘形根(home//tmp/根)只精确匹配,不前缀吞并", () => {
    const ps = [proj("home", [HOME]), proj("tmp", ["/tmp"]), proj("root", ["/"])];
    expect(resolveProjectForDir(ps, HOME)?.id).toBe("home");
    expect(resolveProjectForDir(ps, `${HOME}/repos/anything`)).toBeNull();
    expect(resolveProjectForDir(ps, "/tmp")?.id).toBe("tmp");
    expect(resolveProjectForDir(ps, "/tmp/deep")).toBeNull();
    expect(resolveProjectForDir(ps, "/etc")).toBeNull();
  });
});

describe("slugifyProjectId", () => {
  test("basename 常规转换", () => {
    expect(slugifyProjectId("My Repo", new Set())).toBe("my-repo");
    expect(slugifyProjectId("claude-orchestrator", new Set())).toBe("claude-orchestrator");
  });
  test("CJK 清空后回退 proj", () => {
    expect(slugifyProjectId("青鸟项目", new Set())).toBe("proj");
  });
  test("冲突加后缀", () => {
    expect(slugifyProjectId("web", new Set(["web"]))).toBe("web-2");
    expect(slugifyProjectId("web", new Set(["web", "web-2"]))).toBe("web-3");
  });
  test("产物永远合法", () => {
    for (const raw of ["My Repo", "青鸟", "--x--", "a".repeat(80)]) {
      expect(PROJECT_ID_RE.test(slugifyProjectId(raw, new Set()))).toBe(true);
    }
  });
});

describe("read/write roundtrip", () => {
  test("写后读回等价;坏文件/缺文件返回空", async () => {
    const dir = mkdtempSync(join(tmpdir(), "projects-test-"));
    const path = join(dir, "projects.json");
    expect((await readProjects(path)).projects).toEqual([]);
    const data = {
      projects: [
        { id: "a", name: "A", emoji: "🅰️", dirs: ["/x"], description: "d", createdAt: "t" },
        proj("b", ["/y", "/z"]),
      ],
    };
    await writeProjects(data, path);
    const back = await readProjects(path);
    expect(back.projects).toHaveLength(2);
    expect(back.projects[0]).toEqual(data.projects[0]);
    expect(back.projects[1].dirs).toEqual(["/y", "/z"]);
    // 脏数据容错:非法条目被跳过,缺 name 回退 id
    await Bun.write(path, JSON.stringify({ projects: [{ id: "c", dirs: ["/c", 42] }, { nope: 1 }, null] }));
    const dirty = await readProjects(path);
    expect(dirty.projects).toHaveLength(1);
    expect(dirty.projects[0].name).toBe("c");
    expect(dirty.projects[0].dirs).toEqual(["/c"]);
    await Bun.write(path, "not json");
    expect((await readProjects(path)).projects).toEqual([]);
  });
});

import { isMisfiledByUmbrella } from "../src/lib/projects.js";

describe("isMisfiledByUmbrella(v2.21.3 傘形根误归属识别)", () => {
  const HOME = process.env.HOME || "/Users/x";
  const shawn = { id: "shawn", name: "家目录杂项", dirs: [HOME], createdAt: "" };
  const qn = { id: "qingniao", name: "青鸟", dirs: [`${HOME}/repos/qingniao-miniapp`, `${HOME}/repos/qingniao-backend`], createdAt: "" };
  test("cwd 在家目录之下、只靠 $HOME 前缀沾边 → 误归属", () => {
    expect(isMisfiledByUmbrella(shawn, `${HOME}/repos/terrarium`)).toBe(true);
    expect(isMisfiledByUmbrella({ ...shawn, dirs: ["/tmp"] }, "/tmp/nike-adapt")).toBe(true);
  });
  test("cwd 精确等于傘形 dir → 归属成立", () => {
    expect(isMisfiledByUmbrella(shawn, HOME)).toBe(false);
    expect(isMisfiledByUmbrella({ ...shawn, dirs: ["/tmp"] }, "/tmp")).toBe(false);
  });
  test("非傘形 dir 精确/前缀命中 → 归属成立", () => {
    expect(isMisfiledByUmbrella(qn, `${HOME}/repos/qingniao-backend`)).toBe(false);
    expect(isMisfiledByUmbrella(qn, `${HOME}/repos/qingniao-backend/src`)).toBe(false);
  });
  test("完全不沾边(显式指派的 review agent)→ 不算误归属", () => {
    expect(isMisfiledByUmbrella(qn, `${HOME}/repos/other`)).toBe(false);
  });
  test("傘形与非傘形并存:非傘形命中优先", () => {
    const mixed = { ...shawn, dirs: [HOME, `${HOME}/repos/terrarium`] };
    expect(isMisfiledByUmbrella(mixed, `${HOME}/repos/terrarium`)).toBe(false);
    expect(isMisfiledByUmbrella(mixed, `${HOME}/repos/router`)).toBe(true);
  });
});
