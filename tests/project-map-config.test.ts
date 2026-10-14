/**
 * project-map-PDSTATE2：项目地图配置的读取与校验。板块和冻结名单只用合成 id。
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { projectMapConfig } from "../src/lib/project-map-config.js";

let dir = "", warn: ReturnType<typeof spyOn>, error: ReturnType<typeof spyOn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "project-map-"));
  warn = spyOn(console, "warn").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); error.mockRestore(); rmSync(dir, { recursive: true, force: true }); });
const file = (name: string, body: unknown) => {
  const p = join(dir, name);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
};
const logs = () => warn.mock.calls.length + error.mock.calls.length;

test("[验收线 2] 文件不存在 → 空配置且不打日志；项目不在文件里 → 空", () => {
  const r = projectMapConfig("p", join(dir, "none.json"));
  expect(r.areas).toEqual([]);
  expect([...r.frozen]).toEqual([]);
  expect(projectMapConfig("q", file("ok.json", { p: { frozenTasks: ["T1"] } }))).toEqual({ areas: [], frozen: new Set() });
  expect(logs()).toBe(0);
});

test("[验收线 2] 坏 JSON → 空配置，读两次只报一次", () => {
  const p = file("bad.json", "{ not json");
  expect(projectMapConfig("p", p)).toEqual({ areas: [], frozen: new Set() });
  expect(projectMapConfig("p", p)).toEqual({ areas: [], frozen: new Set() });
  expect(logs()).toBe(1);
  // 顶层不是对象也算坏
  expect(projectMapConfig("p", file("arr.json", [1]))).toEqual({ areas: [], frozen: new Set() });
});

test("[验收线 2] 正常读：板块按配置顺序，冻结名单只收字符串", () => {
  const p = file("ok.json", { p: {
    areas: [{ id: "alpha", name: "甲组", features: ["f1", "f2"] }, { id: "beta-2", name: "乙组", features: [] }],
    frozenTasks: ["T1", 7, "T2"],
  } });
  const r = projectMapConfig("p", p);
  expect(r.areas).toEqual([{ id: "alpha", name: "甲组", features: ["f1", "f2"] }, { id: "beta-2", name: "乙组", features: [] }]);
  expect([...r.frozen]).toEqual(["T1", "T2"]);
});

test("[验收线 2] 一个板块不合格只丢那一个、只 warn 一次；重复 feature 取第一个板块", () => {
  const p = file("mixed.json", { p: { areas: [
    { id: "alpha", name: "甲", features: ["f1", "f2"] },
    { id: "Bad_ID", name: "坏", features: ["f3"] },
    { id: "gamma", name: "丙", features: ["f2", "f4"] },
    { id: "delta", name: "名".repeat(21), features: [] },
    { id: "eps", name: "", features: [] },
    { id: "zeta", name: "己", features: [1] },
    { id: "alpha", name: "重复", features: ["f5"] },
  ] } });
  const r = projectMapConfig("p", p);
  expect(r.areas).toEqual([{ id: "alpha", name: "甲", features: ["f1", "f2"] }, { id: "gamma", name: "丙", features: ["f4"] }]);
  const n = logs();
  expect(n).toBe(5);
  projectMapConfig("p", p);
  expect(logs()).toBe(n);
});

test("[验收线 2] 上限：板块最多 12 个，冻结名单最多 200 个；字段类型不对按空", () => {
  const areas = Array.from({ length: 14 }, (_, i) => ({ id: `a${i}`, name: `组${i}`, features: [`f${i}`] }));
  const frozenTasks = Array.from({ length: 205 }, (_, i) => `T${i}`);
  const r = projectMapConfig("p", file("big.json", { p: { areas, frozenTasks } }));
  expect(r.areas.map((a) => a.id)).toEqual(areas.slice(0, 12).map((a) => a.id));
  expect(r.frozen.size).toBe(200);
  expect(projectMapConfig("p", file("types.json", { p: { areas: {}, frozenTasks: "T1" } }))).toEqual({ areas: [], frozen: new Set() });
  expect(projectMapConfig("p", file("entry.json", { p: [] }))).toEqual({ areas: [], frozen: new Set() });
});
