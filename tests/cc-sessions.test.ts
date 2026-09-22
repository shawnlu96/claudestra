import { describe, expect, test } from "bun:test";
import { parseCcSessionEntry, pickCcSessionForWindow, procStartMatches, type CcSessionEntry } from "../src/lib/cc-sessions";

const SRC = "32bd5a87-6982-4717-aef2-58d80812935b";
const FORK = "72aabe18-8395-43ee-a9e0-31abdf8aab4e";
const e = (o: Partial<CcSessionEntry> & { pid: number; sessionId: string }): CcSessionEntry => ({ cwd: "/Users/shawn/repos/gc-car", ...o });

describe("parseCcSessionEntry", () => {
  test("真实登记（master 2026-09-18 案例）", () => {
    const raw = '{"pid":16304,"sessionId":"72aabe18-8395-43ee-a9e0-31abdf8aab4e","cwd":"/Users/shawn/repos/gc-car","startedAt":1789671687953,"tmux":"master:@1111.%1111","name":"gc-car-chat","status":"busy"}';
    expect(parseCcSessionEntry(raw)).toEqual({ pid: 16304, sessionId: FORK, cwd: "/Users/shawn/repos/gc-car", startedAt: 1789671687953, tmux: "master:@1111.%1111", name: "gc-car-chat", status: "busy" });
  });
  test("保留 status / kind / procStart / entrypoint——takeover 的 busy 保护与 pid 复用校验靠它们", () => {
    // CC 2.1.280 真实登记（字段节选）
    const raw = '{"pid":72201,"sessionId":"3f21e202-1ff9-4048-a6aa-9ad51fa0f481","cwd":"/x","startedAt":1790099225278,"procStart":"Tue Sep 22 17:47:04 2026","kind":"interactive","entrypoint":"cli","status":"busy"}';
    const got = parseCcSessionEntry(raw)!;
    expect(got.status).toBe("busy");
    expect(got.kind).toBe("interactive");
    expect(got.procStart).toBe("Tue Sep 22 17:47:04 2026");
    expect(got.entrypoint).toBe("cli");
  });
  test("坏 JSON / 缺 pid / 缺 sessionId → null", () => {
    expect(parseCcSessionEntry("{")).toBeNull();
    expect(parseCcSessionEntry('{"sessionId":"x"}')).toBeNull();
    expect(parseCcSessionEntry('{"pid":1}')).toBeNull();
  });
});

describe("pickCcSessionForWindow", () => {
  const src = e({ pid: 9001, sessionId: SRC, tmux: "master:@900.%900", startedAt: 100 });
  const fork = e({ pid: 16304, sessionId: FORK, tmux: "master:@1111.%1111", startedAt: 200 });

  test("窗口 shell 的子进程 pid 命中 → 该登记的 sessionId（fork 出的新 id，不是源）", () => {
    expect(pickCcSessionForWindow([src, fork], { childPids: [16304], paneId: "%1111", exclude: SRC })?.sessionId).toBe(FORK);
  });
  test("pid 没命中（ps 抽风）→ 按 tmux pane id 兜底", () => {
    expect(pickCcSessionForWindow([src, fork], { childPids: [], paneId: "%1111" })?.sessionId).toBe(FORK);
  });
  test("exclude 排除源 id：即便只有源登记也不冒认", () => {
    expect(pickCcSessionForWindow([src], { childPids: [9001], paneId: "%900", exclude: SRC })).toBeNull();
  });
  test("多个候选：cwd 一致优先，再取 startedAt 最新", () => {
    const other = e({ pid: 7, sessionId: "other", cwd: "/elsewhere", startedAt: 999 });
    const older = e({ pid: 8, sessionId: "older", startedAt: 50 });
    expect(pickCcSessionForWindow([other, older, fork], { childPids: [7, 8, 16304], cwd: "/Users/shawn/repos/gc-car" })?.sessionId).toBe(FORK);
    // cwd 全不一致时不因此放弃——仍按 startedAt 最新
    expect(pickCcSessionForWindow([other, older], { childPids: [7, 8], cwd: "/nomatch" })?.sessionId).toBe("other");
  });
  test("什么都没命中 → null", () => {
    expect(pickCcSessionForWindow([src, fork], { childPids: [1], paneId: "%5" })).toBeNull();
    expect(pickCcSessionForWindow([], { childPids: [16304] })).toBeNull();
  });
});

describe("procStartMatches — 识破 pid 复用的过期登记", () => {
  // 登记 procStart 实测是 UTC，ps lstart 是本地时区：两边换算成绝对时间再比
  const utc = "Tue Sep 22 18:23:19 2026";
  const startMs = Date.parse(`${utc} GMT`);
  /** 仿 `ps -o lstart=` 的本地时间格式：Wed Sep 23 03:23:19 2026 */
  const psOf = (ms: number) => {
    const [wd, mon, day, year, time] = new Date(ms).toString().split(" ");
    return `${wd} ${mon} ${day} ${time} ${year}`;
  };

  test("同一个进程（UTC 登记 vs 本地 lstart）→ 匹配", () => {
    expect(procStartMatches({ procStart: utc }, psOf(startMs))).toBe(true);
  });
  test("pid 被复用给后来的进程 → 不匹配", () => {
    expect(procStartMatches({ procStart: utc }, psOf(startMs + 3_600_000))).toBe(false);
  });
  test("没有 procStart 时退回 startedAt（启动后一两秒才写）", () => {
    expect(procStartMatches({ startedAt: startMs + 1_056 }, psOf(startMs))).toBe(true);
    expect(procStartMatches({ startedAt: startMs + 600_000 }, psOf(startMs))).toBe(false);
  });
  test("判断不了（进程没了 / 登记里没有时间）→ false，宁可不动手", () => {
    expect(procStartMatches({ procStart: utc }, "")).toBe(false);
    expect(procStartMatches({}, psOf(startMs))).toBe(false);
  });
});
