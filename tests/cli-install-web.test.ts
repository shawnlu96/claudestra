/**
 * install-cli 里与前端有关的纯函数。前端由 bridge 托管静态包（web/out），机器上不再装 web 服务；
 * 留下的只有旧端口的解析（中继的子域名兼容隧道还在用）和写进 plist 的可执行路径判定。
 */
import { describe, test, expect } from "bun:test";
import { preferStablePath, WEB_PORT_FALLBACK, webPortFromStartScript } from "../src/lib/cli-install.js";

describe("webPortFromStartScript", () => {
  test("从 next start 抠端口——package.json 是端口的唯一真源", () => {
    expect(webPortFromStartScript("next start -p 3333")).toBe(3333);
    expect(webPortFromStartScript("next start --port 8080")).toBe(8080);
    expect(webPortFromStartScript("next start --port=8080")).toBe(8080);
  });

  test("没写端口 / 没有 start 脚本 → 用兜底值（不能拿 NaN 去拼地址）", () => {
    expect(webPortFromStartScript("next start")).toBe(WEB_PORT_FALLBACK);
    expect(webPortFromStartScript(undefined)).toBe(WEB_PORT_FALLBACK);
    expect(webPortFromStartScript("")).toBe(WEB_PORT_FALLBACK);
  });

  test("越界端口不采信", () => {
    expect(webPortFromStartScript("next start -p 99999")).toBe(WEB_PORT_FALLBACK);
    expect(webPortFromStartScript("next start -p 0")).toBe(WEB_PORT_FALLBACK);
  });
});

/**
 * 写进 plist 的可执行文件路径（2026-09-22 试装：launchctl 报 exit 127）。
 * 两个方向相反的坑，既不能一律用 which 的结果、也不能一律 realpath。
 * 现在只影响 daemon PATH 里的 node 目录（自动更新跑 npm run build 要用）。
 */
describe("preferStablePath", () => {
  const exists = (x: string) => !x.includes("MISSING");

  test("brew 的稳定软链保持原样——realpath 出来的 Cellar 路径下次升级就没了", () => {
    const got = preferStablePath("/opt/homebrew/bin/node", () => "/opt/homebrew/Cellar/node/26.4.0/bin/node", exists);
    expect(got).toBe("/opt/homebrew/bin/node");
  });

  test("fnm 的多壳缓存必须解析——那个目录随装机的 shell 退出就没了（正是 127 的成因）", () => {
    const shim = "/Users/u/Library/Caches/fnm_multishells/123_456/bin/node";
    const real = "/Users/u/.local/share/fnm/node-versions/v22/installation/bin/node";
    expect(preferStablePath(shim, () => real, exists)).toBe(real);
  });

  test("/tmp 与 /var/folders 同样当临时处理", () => {
    expect(preferStablePath("/tmp/x/bin/node", () => "/opt/node", exists)).toBe("/opt/node");
    expect(preferStablePath("/var/folders/ab/cd/T/bin/node", () => "/opt/node", exists)).toBe("/opt/node");
  });

  test("解析后的路径不存在 → 退回原路径（总比没有强）", () => {
    const shim = "/Users/u/Library/Caches/fnm_multishells/1_2/bin/node";
    expect(preferStablePath(shim, () => "/MISSING/node", exists)).toBe(shim);
  });

  test("两个都不存在 → null", () => {
    expect(preferStablePath("/MISSING/node", () => "/MISSING/real", exists)).toBeNull();
  });

  test("realpath 抛异常不炸（权限 / 断链）", () => {
    const shim = "/tmp/bin/node";
    expect(preferStablePath(shim, () => { throw new Error("EACCES"); }, exists)).toBe(shim);
  });
});
