import { test, expect, describe } from "bun:test";
import { classifyDaemonExit, formatDoctor, orphanAgentNames, webBuildVerdict, type Check } from "../src/lib/doctor";

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

describe("webBuildVerdict（按 hash 判，与 install-cli 自动重建共用）", () => {
  const T = 1_700_000_000_000;
  const base = { buildIdMtimeMs: T, buildInfoMtimeMs: T - 120_000, bakedWebCommit: "0df41f5", headWebCommit: "0df41f5", lastWebCommitMs: T - 3600_000 };
  test("无构建产物 → stale", () => {
    const v = webBuildVerdict({ ...base, buildIdMtimeMs: null });
    expect(v.stale).toBe(true);
    expect(v.status).toBe("warn");
  });
  test("烤入 hash 与 web 最新提交一致 → ok", () => {
    expect(webBuildVerdict(base)).toMatchObject({ status: "ok", stale: false });
  });
  test("缩写长度不同但同一提交 → ok", () => {
    expect(webBuildVerdict({ ...base, headWebCommit: "0df41f5a" }).stale).toBe(false);
  });
  test("烤入 hash ≠ 最新提交 → stale（哪怕 BUILD_ID 比提交时间新：release tag 里的提交常早于拉取）", () => {
    const v = webBuildVerdict({ ...base, headWebCommit: "a4c11db", lastWebCommitMs: T - 86_400_000 });
    expect(v.stale).toBe(true);
    expect(v.detail).toContain("a4c11db");
  });
  test("只改了 web/*.md：head 按排除 md 的 pathspec 算，仍等于烤入值 → ok（不白建）", () => {
    // 调用方用 WEB_PATHSPEC 取 head；md-only 提交不会让它前进，提交时间再新也不看
    expect(webBuildVerdict({ ...base, lastWebCommitMs: T + 3600_000 }).stale).toBe(false);
  });
  test("build-info 比 BUILD_ID 新 = prebuild 写了新值但构建没完成 → stale", () => {
    expect(webBuildVerdict({ ...base, buildInfoMtimeMs: T + 1 }).stale).toBe(true);
  });
  test("拿不到 hash 才退回时间比较（60s 容差）", () => {
    const noHash = { ...base, bakedWebCommit: null, headWebCommit: null };
    expect(webBuildVerdict({ ...noHash, lastWebCommitMs: T + 61_000 }).stale).toBe(true);
    expect(webBuildVerdict({ ...noHash, lastWebCommitMs: T + 59_000 }).stale).toBe(false);
    expect(webBuildVerdict({ ...noHash, lastWebCommitMs: null }).status).toBe("ok");
  });
});

// ── v2.17.2 端口属主校验(peer 实报 pm2 遗留抢占 3847,launchd 份崩 12908 次)──
import { portOwnerVerdict } from "../src/lib/doctor";

describe("portOwnerVerdict", () => {
  test("listener == launchd pid → ok", () => {
    expect(portOwnerVerdict("123", "123")!.status).toBe("ok");
  });
  test("listener != launchd pid → fail(双托管冲突)", () => {
    const v = portOwnerVerdict("123", "456")!;
    expect(v.status).toBe("fail");
    expect(v.detail).toContain("双托管");
  });
  test("有 listener 但 launchd 没在跑 → fail(被别的托管方式抢占)", () => {
    expect(portOwnerVerdict("123", null)!.status).toBe("fail");
  });
  test("无 listener → null(交给已有的端口 fail)", () => {
    expect(portOwnerVerdict(null, "123")).toBeNull();
  });
});

// ── orphanAgentNames（2026-09-21：13 个退役 agent 被永久点名）────────────────
// 「registry 里有、tmux 里没有」对 stopped 的 agent 是**定义**不是异常。判据写宽
// 了就把一条真信号（自称 active 但窗口没了）变成常年黄灯，跟上面 SIGTERM 那条
// 是同一类错误：警告一旦常态化就没人看了。
describe("orphanAgentNames", () => {
  const win = new Set(["agent-alive", "master"]);

  test("active 且没有 window → 是孤儿", () => {
    expect(orphanAgentNames([{ name: "agent-gone", status: "active" }], win)).toEqual(["agent-gone"]);
  });

  test("stopped 没有 window → 不是孤儿（那正是「已停」的定义）", () => {
    expect(orphanAgentNames([{ name: "agent-retired", status: "stopped" }], win)).toEqual([]);
  });

  test("active 且 window 在 → 不是孤儿", () => {
    expect(orphanAgentNames([{ name: "agent-alive", status: "active" }], win)).toEqual([]);
  });

  test("大总管跳过：window 名是裸 master，registry 键是 agent-master，比对必然对不上", () => {
    expect(orphanAgentNames([{ name: "agent-master", status: "active" }], win)).toEqual([]);
    expect(orphanAgentNames([{ name: "master", status: "active" }], new Set<string>())).toEqual([]);
  });

  test("status 缺失（老数据）不当 active 报", () => {
    expect(orphanAgentNames([{ name: "agent-legacy" }], win)).toEqual([]);
  });

  test("混合名单只挑出真孤儿", () => {
    const got = orphanAgentNames(
      [
        { name: "agent-alive", status: "active" },
        { name: "agent-gone", status: "active" },
        { name: "agent-retired", status: "stopped" },
        { name: "agent-master", status: "active" },
      ],
      win,
    );
    expect(got).toEqual(["agent-gone"]);
  });
});
