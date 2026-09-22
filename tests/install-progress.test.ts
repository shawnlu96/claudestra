/**
 * 「上次装到哪一步」的探测（v2.24+）。
 *
 * 由来：试装的人装到一半断了，重跑向导时收尾那步见到 .env 已存在会问「要覆盖吗？」
 * 且默认**否** → 一路回车就 exit(1)，重跑比第一次还难走通。判据一律取落盘事实。
 */
import { describe, test, expect } from "bun:test";
import { assessInstall, progressChecklist, skippableSteps } from "../src/lib/install-progress.js";

const none = {
  envFile: false, webEnvLocal: false, webNextBin: false,
  webBuildId: false, bridgePlist: false, webPlist: false,
};
const all = {
  envFile: true, webEnvLocal: true, webNextBin: true,
  webBuildId: true, bridgePlist: true, webPlist: true,
};

describe("assessInstall", () => {
  test("全新机器：既不是续装也不是装完", () => {
    const p = assessInstall(none);
    expect(p.partial).toBe(false);
    expect(p.complete).toBe(false);
  });

  test("只要有一项做完就算续装（横幅据此出现）", () => {
    expect(assessInstall({ ...none, envFile: true }).partial).toBe(true);
    expect(assessInstall({ ...none, webNextBin: true }).partial).toBe(true);
  });

  test("全齐 = complete（重跑只是改配置）", () => {
    const p = assessInstall(all);
    expect(p.complete).toBe(true);
    expect(p.partial).toBe(true);
  });
});

describe("skippableSteps", () => {
  test("依赖在就不重装", () => {
    expect(skippableSteps(assessInstall({ ...none, webNextBin: true })).webInstall).toBe(true);
  });

  test("有构建产物但依赖没了 → 不能跳过构建", () => {
    // .next 里烤的是上一份依赖的产物；依赖重装过就必须重新构建。
    const p = assessInstall({ ...none, webBuildId: true, webNextBin: false });
    expect(p.webBuildId).toBe(true);
    expect(skippableSteps(p).webBuild).toBe(false);
  });

  test("依赖和产物都在才跳过构建", () => {
    expect(skippableSteps(assessInstall(all)).webBuild).toBe(true);
  });

  test("全新机器什么都不跳", () => {
    const s = skippableSteps(assessInstall(none));
    expect(s.webInstall).toBe(false);
    expect(s.webBuild).toBe(false);
  });
});

describe("progressChecklist", () => {
  test("六项都列出来，顺序稳定（横幅逐行渲染它）", () => {
    const rows = progressChecklist(assessInstall({ ...none, envFile: true }));
    expect(rows.map((r) => r.key)).toEqual([
      "envFile", "webEnvLocal", "webNextBin", "webBuildId", "bridgePlist", "webPlist",
    ]);
    expect(rows[0].done).toBe(true);
    expect(rows[1].done).toBe(false);
  });
});
