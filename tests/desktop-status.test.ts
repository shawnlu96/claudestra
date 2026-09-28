import { describe, expect, test } from "bun:test";
import { desktopLabels, labelsOverrideFiles, overallStatus, updateHolder, BUN_AUTO_ENV_FILES, LABELS_ENV } from "../src/lib/desktop-status";
import { daemonState, launchctlEntry } from "../src/lib/launchd-status";

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
    expect(daemonState(LIST, "com.claudestra.bridge", true)).toMatchObject({ name: "bridge", status: "ok", loaded: true, running: true, pid: 49401 });
  });
  test("加载了但没在跑 → fail", () => {
    expect(daemonState(LIST, "com.claudestra.cron", true)).toMatchObject({ status: "fail", loaded: true, running: false, pid: null });
  });
  test("没加载：有 plist 是 fail，连 plist 都没有（没装）只是 warn——和 doctor 同口径", () => {
    expect(daemonState(LIST, "com.claudestra.x", true)).toMatchObject({ status: "fail", loaded: false, detail: "plist 在，但没 load" });
    expect(daemonState(LIST, "com.claudestra.x", false)).toMatchObject({ status: "warn", loaded: false, detail: "没装" });
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
  test("不设就是三个 launchd 服务，launcher 最后", () => {
    const l = desktopLabels({});
    expect(l).toHaveLength(3);
    expect(l[2]).toBe("com.claudestra.launcher");
  });
  test("开发实测可换成假 label", () => {
    expect(desktopLabels({ [LABELS_ENV]: " com.x-t18test.dummy , a.b " })).toEqual(["com.x-t18test.dummy", "a.b"]);
  });
  test("设了但是空白 → 报错，绝不悄悄回落到真服务", () => {
    expect(() => desktopLabels({ [LABELS_ENV]: "" })).toThrow();
    expect(() => desktopLabels({ [LABELS_ENV]: "   " })).toThrow();
    expect(() => desktopLabels({ [LABELS_ENV]: " , " })).toThrow();
  });
  test("非法字符和 com.apple.* 一律拒绝", () => {
    expect(() => desktopLabels({ [LABELS_ENV]: "a;rm" })).toThrow();
    expect(() => desktopLabels({ [LABELS_ENV]: "com.apple.Finder" })).toThrow();
    expect(() => desktopLabels({ [LABELS_ENV]: "ok.label,COM.APPLE.x" })).toThrow();
  });
});

describe("labelsOverrideFiles", () => {
  test("Bun 自动加载的每个 env 文件都查：写在 .env.local / .env.$NODE_ENV 里同样拒绝", () => {
    const files: Record<string, Record<string, string>> = {
      ".env": { BRIDGE_PORT: "3847" },
      ".env.local": { [LABELS_ENV]: "com.x.dummy" },
      ".env.test": { [LABELS_ENV]: "" },
    };
    expect(labelsOverrideFiles((f) => files[f] ?? null)).toEqual([".env.local", ".env.test"]);
  });
  test("都没写（或文件都不存在）→ 空", () => {
    expect(labelsOverrideFiles(() => null)).toEqual([]);
    expect(labelsOverrideFiles(() => ({ BRIDGE_PORT: "1" }))).toEqual([]);
  });
  test("覆盖 .env、.env.local 和三个 NODE_ENV 变体", () => {
    expect(BUN_AUTO_ENV_FILES).toEqual([".env", ".env.local", ".env.development", ".env.production", ".env.test"]);
  });
});

describe("updateHolder", () => {
  const now = 10_000_000;
  const alive = (pid: number) => pid === 42;
  test("锁里的 pid 活着、锁新鲜 → 正在更新", () => {
    expect(updateHolder({ text: "42\n", mtimeMs: now - 60_000 }, now, alive)).toBe(42);
  });
  test("没锁、pid 已死、锁超过 30 分钟、内容不是 pid → 不算在更新", () => {
    expect(updateHolder(null, now, alive)).toBeNull();
    expect(updateHolder({ text: "7", mtimeMs: now }, now, alive)).toBeNull();
    expect(updateHolder({ text: "42", mtimeMs: now - 30 * 60_000 }, now, alive)).toBeNull();
    expect(updateHolder({ text: "garbage", mtimeMs: now }, now, alive)).toBeNull();
  });
});
