/**
 * SYN-2 r1 P1 projects-retry（web/features/chat/projects-refresh.ts）：首次 /projects 失败后有界时间内重试成功；
 * 成功后低频刷新到点能拿到项目元数据的变化；重试有上限；guest（skip）不重试。计时器是真的，等待时间按常量缩放不了，
 * 所以只用第一档重试（2s）走真等待，低频刷新用注入的时钟。
 */
import { expect, test } from "bun:test";
import { PROJECTS_REFRESH_MS, PROJECTS_RETRY_MS, ProjectsRefresh } from "../web/features/chat/projects-refresh";

test("首次失败 → 第一档退避后自动重试成功，期间 due() 不重复触发", async () => {
  const results: ("ok" | "fail")[] = ["fail", "ok"];
  let calls = 0;
  const r = new ProjectsRefresh(async () => (calls++, results.shift() ?? "ok"));
  await r.run();
  expect(calls).toBe(1);
  expect(r.due()).toBe(false); // 重试排着，轮询节拍不再插一次
  await new Promise((done) => setTimeout(done, PROJECTS_RETRY_MS[0] + 200));
  expect(calls).toBe(2);
  expect(r.due()).toBe(false); // 成功了，下次是低频刷新
}, 10_000);

test("成功后低频刷新：到 PROJECTS_REFRESH_MS 才 due，拉到的就是变了的元数据", async () => {
  let t = 1_000_000;
  let meta = { name: "旧名", emoji: "📦" };
  const got: { seen: typeof meta | null } = { seen: null };
  const r = new ProjectsRefresh(async () => ((got.seen = { ...meta }), "ok"), () => t);
  await r.run();
  expect(got.seen).toEqual({ name: "旧名", emoji: "📦" });
  meta = { name: "新名", emoji: "🚀" }; // 别的设备 / CLI 改了
  t += PROJECTS_REFRESH_MS - 1;
  expect(r.due()).toBe(false);
  t += 2;
  expect(r.due()).toBe(true);
  await r.run();
  expect(got.seen).toEqual({ name: "新名", emoji: "🚀" });
});

test("一直失败：重试次数有上限，之后回到低频节拍；guest（skip）不重试", async () => {
  const timers: number[] = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((f: () => void, ms: number) => (timers.push(ms), real(f, 0))) as typeof setTimeout;
  try {
    let calls = 0;
    const r = new ProjectsRefresh(async () => (calls++, "fail"));
    await r.run();
    for (let i = 0; i < 10; i++) await new Promise((done) => real(done, 5));
    expect(calls).toBe(PROJECTS_RETRY_MS.length + 1);
    expect(timers).toEqual([...PROJECTS_RETRY_MS]);
    expect(r.due()).toBe(false);
    let skips = 0;
    const g = new ProjectsRefresh(async () => (skips++, "skip"));
    await g.run();
    for (let i = 0; i < 3; i++) await new Promise((done) => real(done, 5));
    expect(skips).toBe(1);
  } finally {
    globalThis.setTimeout = real;
  }
});

test("在途时又要刷新（操作之后）：不被操作之前发出的那次满足，等它结束再补拉一次；在途期间多次调用只补一次（r2 P1）", async () => {
  let version = 1;
  const gates: (() => void)[] = [];
  const seen: number[] = [];
  const r = new ProjectsRefresh(async () => {
    const v = version;
    await new Promise<void>((done) => gates.push(done));
    seen.push(v);
    return "ok";
  });
  const before = r.run(); // 操作之前发出的
  version = 2; // 操作改了项目
  const after = r.run();
  const after2 = r.run();
  gates.shift()!();
  await before;
  expect(seen).toEqual([1]);
  await new Promise((done) => setTimeout(done, 0));
  gates.shift()!();
  await after;
  await after2;
  expect(seen).toEqual([1, 2]);
  expect(gates.length).toBe(0);
});
