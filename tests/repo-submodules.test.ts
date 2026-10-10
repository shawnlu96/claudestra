/** i28-SECPOOL3：src/lib/repo-submodules.ts —— 有 .gitmodules 才拉子模块，git 调用由调用方注入 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submodulePaths, updateSubmodules, type SubmoduleGit } from "../src/lib/repo-submodules.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (gitmodules?: string) => {
  const d = mkdtempSync(join(tmpdir(), "repo-sub-"));
  dirs.push(d);
  if (gitmodules !== undefined) writeFileSync(join(d, ".gitmodules"), gitmodules);
  return d;
};
const MODULES = '[submodule "vendor/claudestra"]\n\tpath = vendor/claudestra\n\turl = https://github.com/o/c.git\n[submodule "evil"]\n\tpath = ../out\n\turl = x\n[submodule "abs"]\n  path=/etc\n';

describe("updateSubmodules", () => {
  test("没有 .gitmodules：一次 git 都不调，直接成功", async () => {
    const calls: string[][] = [];
    expect(await updateSubmodules(temp(), async (a) => (calls.push(a), { code: 0, out: "" }))).toEqual({ ok: true, paths: [] });
    expect(calls).toEqual([]);
  });

  test("有 .gitmodules：调一次 submodule update --init --recursive，返回仓库内的子模块路径", async () => {
    const calls: string[][] = [];
    expect(await updateSubmodules(temp(MODULES), async (a) => (calls.push(a), { code: 0, out: "" }))).toEqual({ ok: true, paths: ["vendor/claudestra"] });
    expect(calls).toEqual([["submodule", "update", "--init", "--recursive"]]);
  });

  test("失败带原因（写明子模块），null 退出码、抛错都不外泄成异常", async () => {
    const fail: SubmoduleGit = async () => ({ code: 128, out: "fatal: remote error: upload-pack: not our ref deadbeef" });
    expect(await updateSubmodules(temp(MODULES), fail)).toEqual({ ok: false, reason: "拉子模块失败：fatal: remote error: upload-pack: not our ref deadbeef" });
    expect(await updateSubmodules(temp(MODULES), async () => ({ code: null, out: "" }))).toEqual({ ok: false, reason: "拉子模块失败：exit null" });
    expect(await updateSubmodules(temp(MODULES), async () => { throw new Error("spawn ENOENT"); })).toEqual({ ok: false, reason: "拉子模块失败：spawn ENOENT" });
  });

  test("submodulePaths：绝对路径、带 .. 的不收；没有文件 = []", () => {
    expect(submodulePaths(temp(MODULES))).toEqual(["vendor/claudestra"]);
    expect(submodulePaths(temp())).toEqual([]);
  });
});
