/**
 * 「上次装到哪一步」的探测（v2.24+）。
 *
 * 由来：试装的人装到一半断了，重跑向导时收尾那步见到 .env 已存在会问「要覆盖吗？」
 * 且默认**否** → 一路回车就 exit(1)，重跑比第一次还难走通。判据一律取落盘事实。
 */
import { describe, test, expect } from "bun:test";
import { assessInstall, parseClientWebCommit, progressChecklist, skippableSteps, webBuildFresh, webDepsFresh } from "../src/lib/install-progress.js";

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

describe("新鲜度：文件在 ≠ 是这一版的（切版本后重跑 setup）", () => {
  test("依赖过期 → 重装依赖，也就必须重新构建", () => {
    const s = skippableSteps(assessInstall({ ...all, webDepsFresh: false }));
    expect(s.webInstall).toBe(false);
    expect(s.webBuild).toBe(false);
  });
  test("只有构建过期 → 依赖跳过、重新构建", () => {
    const s = skippableSteps(assessInstall({ ...all, webDepsFresh: true, webBuildFresh: false }));
    expect(s.webInstall).toBe(true);
    expect(s.webBuild).toBe(false);
  });
  test("都新鲜 → 都跳过", () => {
    const s = skippableSteps(assessInstall({ ...all, webDepsFresh: true, webBuildFresh: true }));
    expect(s).toEqual({ webInstall: true, webBuild: true });
  });

  test("webDepsFresh：npm 写的 .package-lock.json 不早于 package-lock.json", () => {
    expect(webDepsFresh(100, 200)).toBe(true);
    expect(webDepsFresh(200, 100)).toBe(false);
    expect(webDepsFresh(200, null)).toBe(false);
    expect(webDepsFresh(null, null)).toBe(true); // 没有 lock 文件：判断不了
  });

  test("webBuildFresh：产物烤的 web commit 等于当前的", () => {
    const src = 'export const CLIENT_COMMIT = "abc1234";\nexport const CLIENT_WEB_COMMIT = "def5678";\n';
    expect(parseClientWebCommit(src)).toBe("def5678");
    expect(webBuildFresh(parseClientWebCommit(src), "def5678")).toBe(true);
    expect(webBuildFresh(parseClientWebCommit(src), "0000000")).toBe(false);
    // v2.20.1 时代的构建没有 build-info.ts → 过期
    expect(webBuildFresh(parseClientWebCommit(null), "def5678")).toBe(false);
    // 不是 git 检出、拿不到当前 commit → 判断不了，按旧行为
    expect(webBuildFresh(null, null)).toBe(true);
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
