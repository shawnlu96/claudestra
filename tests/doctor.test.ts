import { test, expect, describe } from "bun:test";
import { classifyDaemonExit, formatDoctor, webBuildVerdict, type Check } from "../src/lib/doctor";

describe("classifyDaemonExit", () => {
  test("正常运行 → ok", () => {
    expect(classifyDaemonExit("30530", "0").status).toBe("ok");
  });

  // 回归：SIGTERM 是 `launchctl kickstart -k` 的正常结果。曾把它报成「崩过」,
  // 于是每次重启 bridge 后 doctor 都亮黄灯 —— 警告一旦常态化就没人看了。
  test("SIGTERM（kickstart -k 的正常结果）不算异常", () => {
    const v = classifyDaemonExit("30530", "-15");
    expect(v.status).toBe("ok");
    expect(v.detail).not.toContain("异常");
  });

  test("SIGINT / SIGHUP 同样算正常停止", () => {
    expect(classifyDaemonExit("1", "-2").status).toBe("ok");
    expect(classifyDaemonExit("1", "-1").status).toBe("ok");
  });

  test("SIGKILL 值得提醒（OOM / 强杀）", () => {
    const v = classifyDaemonExit("30530", "-9");
    expect(v.status).toBe("warn");
    expect(v.detail).toContain("SIGKILL");
  });

  test("进程自己非 0 退出 → warn", () => {
    const v = classifyDaemonExit("30530", "1");
    expect(v.status).toBe("warn");
    expect(v.detail).toContain("异常退出");
  });

  test("没在跑 → fail（不管上次退出码是什么）", () => {
    expect(classifyDaemonExit("-", "0").status).toBe("fail");
    expect(classifyDaemonExit("-", "-15").status).toBe("fail");
    expect(classifyDaemonExit("-", "78").status).toBe("fail");
  });

  test("退出码字段是垃圾时按 0 处理，不抛", () => {
    expect(classifyDaemonExit("30530", "").status).toBe("ok");
    expect(classifyDaemonExit("30530", "abc").status).toBe("ok");
  });
});

describe("formatDoctor", () => {
  const mk = (status: Check["status"], name = "x"): Check => ({
    group: "g", name, status, detail: "d", ...(status === "ok" ? {} : { fix: "f" }),
  });

  test("全绿时不说「先处理标 ❌ 的」", () => {
    const s = formatDoctor([mk("ok"), mk("ok", "y")]);
    expect(s).toContain("全部正常");
    expect(s).not.toContain("❌");
  });

  test("只有警告时不谎称有失败项", () => {
    const s = formatDoctor([mk("ok"), mk("warn")]);
    expect(s).toContain("1 项警告");
    expect(s).not.toContain("项失败");
  });

  test("有失败时给出计数并列出修法", () => {
    const s = formatDoctor([mk("fail"), mk("warn")]);
    expect(s).toContain("1 项失败");
    expect(s).toContain("1 项警告");
    expect(s).toContain("↳ f");
  });

  test("按 group 分节，同组只打一次标题", () => {
    const checks: Check[] = [
      { group: "A", name: "1", status: "ok", detail: "d" },
      { group: "A", name: "2", status: "ok", detail: "d" },
      { group: "B", name: "3", status: "ok", detail: "d" },
    ];
    const s = formatDoctor(checks);
    expect(s.match(/── A ──/g)?.length).toBe(1);
    expect(s.match(/── B ──/g)?.length).toBe(1);
  });

  test("ok 项不打印 fix 行", () => {
    expect(formatDoctor([mk("ok")])).not.toContain("↳");
  });
});

describe("webBuildVerdict (v2.16.3 web 构建时效)", () => {
  const T = 1_700_000_000_000;
  test("无构建产物 → warn", () => {
    expect(webBuildVerdict(null, T).status).toBe("warn");
  });
  test("拿不到提交时间 → ok(跳过比对)", () => {
    expect(webBuildVerdict(T, null).status).toBe("ok");
  });
  test("构建落后提交超 60s 容差 → warn", () => {
    expect(webBuildVerdict(T, T + 61_000).status).toBe("warn");
  });
  test("构建新于提交 / 60s 容差内 → ok", () => {
    expect(webBuildVerdict(T + 1, T).status).toBe("ok");
    expect(webBuildVerdict(T, T + 59_000).status).toBe("ok");
  });
});
