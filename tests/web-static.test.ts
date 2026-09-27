/**
 * 前端静态包的判定（lib/web-static.ts）：install-cli 的 warnings、doctor 的「前端静态包」组、旧 web 服务的退场提醒。
 * 机器上没有 web 服务进程了，网页能不能打开只取决于 web/out 在不在 + bridge 知不知道它（BRIDGE_STATIC_DIR）。
 */
import { describe, expect, test } from "bun:test";
import { LEGACY_WEB_DAEMON, legacyWebDaemonCheck, webStaticChecks, webStaticWarnings } from "../src/lib/web-static.js";
import type { WebBuildVerdict } from "../src/lib/web-build.js";

const fresh: WebBuildVerdict = { status: "ok", stale: false, detail: "web 构建与代码一致(abc1234)" };
const stale: WebBuildVerdict = { status: "warn", stale: true, detail: "web 构建落后于代码" };

describe("webStaticWarnings（install-cli 装完该说的话）", () => {
  test("构建了、配了、旧服务不在 → 无话可说", () => {
    expect(webStaticWarnings({ staticDir: "/r/web/out", built: true }, { staticIndex: true, legacyPlist: false })).toEqual([]);
  });

  test("构建了却没配 BRIDGE_STATIC_DIR → 点名：bridge 不托管网页", () => {
    const w = webStaticWarnings({ staticDir: "", built: true }, { staticIndex: false, legacyPlist: false });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("BRIDGE_STATIC_DIR");
    expect(w[0]).toContain("bun run setup");
  });

  test("没构建也没配（没选 web 的实例）→ 不打扰", () => {
    expect(webStaticWarnings({ staticDir: "", built: false }, { staticIndex: false, legacyPlist: false })).toEqual([]);
  });

  test("配了但目录里没有 index.html → 说清会 404 + 怎么修", () => {
    const w = webStaticWarnings({ staticDir: "/r/web/out", built: false }, { staticIndex: false, legacyPlist: false });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("/r/web/out");
    expect(w[0]).toContain("npm run build");
  });

  test("旧 com.claudestra.web 的 plist 还在 → 提醒先 migrate-web-state 再 retire-web（顺序不能反）", () => {
    const w = webStaticWarnings({ staticDir: "/r/web/out", built: true }, { staticIndex: true, legacyPlist: true });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(LEGACY_WEB_DAEMON);
    expect(w[0].indexOf("migrate-web-state")).toBeLessThan(w[0].indexOf("retire-web"));
  });
});

describe("webStaticChecks（doctor「前端静态包」组）", () => {
  test("全好：两行都 ok，第二行报托管的目录", () => {
    const rows = webStaticChecks({ staticDir: "/r/web/out", built: true }, { staticIndex: true }, fresh);
    expect(rows.map((r) => [r.name, r.status])).toEqual([["构建时效", "ok"], ["BRIDGE_STATIC_DIR", "ok"]]);
    expect(rows[1].detail).toContain("/r/web/out");
    expect(rows.every((r) => r.group === "前端静态包")).toBe(true);
  });

  test("构建过期 → 第一行 warn 并给重建命令", () => {
    const rows = webStaticChecks({ staticDir: "/r/web/out", built: true }, { staticIndex: true }, stale);
    expect(rows[0].status).toBe("warn");
    expect(rows[0].fix).toContain("install-cli");
  });

  test("没配 BRIDGE_STATIC_DIR → warn（中继托管的前端不受影响，所以不是 fail）", () => {
    const rows = webStaticChecks({ staticDir: "", built: true }, { staticIndex: false }, fresh);
    expect(rows[1]).toMatchObject({ name: "BRIDGE_STATIC_DIR", status: "warn" });
    expect(rows[1].detail).toContain("中继");
  });

  test("配了但没有 index.html → fail：网页一定 404", () => {
    const rows = webStaticChecks({ staticDir: "/elsewhere", built: false }, { staticIndex: false }, stale);
    expect(rows[1]).toMatchObject({ name: "BRIDGE_STATIC_DIR", status: "fail" });
    expect(rows[1].detail).toContain("/elsewhere");
  });
});

describe("legacyWebDaemonCheck", () => {
  test("plist 不在 → 没有这一行（正常机器不该看到旧服务的字样）", () => {
    expect(legacyWebDaemonCheck(false, "launchd daemon")).toBeNull();
  });

  test("plist 在 → warn，归入 launchd daemon 组，修法指向 retire-web", () => {
    const c = legacyWebDaemonCheck(true, "launchd daemon")!;
    expect(c).toMatchObject({ group: "launchd daemon", name: LEGACY_WEB_DAEMON, status: "warn" });
    expect(c.fix).toContain("retire-web");
  });
});
