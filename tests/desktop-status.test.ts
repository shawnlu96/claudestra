import { describe, expect, test } from "bun:test";
import { daemonState, desktopLabels, launchctlEntry, overallStatus, LABELS_ENV } from "../src/lib/desktop-status";

const LIST = [
  "PID\tStatus\tLabel",
  "49401\t-15\tcom.claudestra.bridge",
  "-\t1\tcom.claudestra.cron",
  "23362\t0\tcom.claudestra.launcher",
  "777\t0\tcom.claudestra.bridge.helper",
].join("\n");

describe("launchctlEntry", () => {
  test("按 label 整列精确匹配，前缀相同的别的服务不算", () => {
    expect(launchctlEntry(LIST, "com.claudestra.bridge")).toEqual({ pid: "49401", exit: "-15" });
    expect(launchctlEntry(LIST, "com.claudestra")).toBeNull();
    expect(launchctlEntry("", "com.claudestra.bridge")).toBeNull();
  });
});

describe("daemonState", () => {
  test("kickstart 后的 -15 算正常在跑", () => {
    expect(daemonState(LIST, "com.claudestra.bridge", true)).toMatchObject({ name: "bridge", status: "ok", running: true, pid: 49401 });
  });
  test("加载了但没在跑 → fail", () => {
    expect(daemonState(LIST, "com.claudestra.cron", true)).toMatchObject({ status: "fail", running: false, pid: null });
  });
  test("没加载：有 plist 和没 plist 分开说", () => {
    expect(daemonState(LIST, "com.claudestra.x", true).detail).toContain("没有加载");
    expect(daemonState(LIST, "com.claudestra.x", false).detail).toBe("没装");
  });
});

describe("overallStatus", () => {
  test("fail 优先于 warn，全 ok 才 ok", () => {
    expect(overallStatus([{ status: "ok" }, { status: "warn" }])).toBe("warn");
    expect(overallStatus([{ status: "warn" }, { status: "fail" }])).toBe("fail");
    expect(overallStatus([{ status: "ok" }])).toBe("ok");
  });
});

describe("desktopLabels", () => {
  test("默认就是三个 launchd 服务，launcher 最后", () => {
    const l = desktopLabels({});
    expect(l).toHaveLength(3);
    expect(l[2]).toBe("com.claudestra.launcher");
  });
  test("开发实测可换成假 label；非法值报错而不是回落到真服务", () => {
    expect(desktopLabels({ [LABELS_ENV]: " com.x-t18test.dummy , a.b " })).toEqual(["com.x-t18test.dummy", "a.b"]);
    expect(() => desktopLabels({ [LABELS_ENV]: "a;rm" })).toThrow();
    expect(() => desktopLabels({ [LABELS_ENV]: " , " })).toThrow();
  });
});
