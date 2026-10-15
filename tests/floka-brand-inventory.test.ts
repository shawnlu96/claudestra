/**
 * BRAND1 并进来的清点修补（scripts/rename-floka/inventory.ts + identifiers.json）：
 * 扫描器的正则前缀表补 `<` 与展开运算符 `...`；清单里不再有「待建」占位卡名；两条按 PM 定稿改过的登记项。
 * 只在临时目录里造合成仓库，不扫真仓库（同 tests/floka-inventory.test.ts）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInventory, type Manifest } from "../scripts/rename-floka/inventory.ts";

const MANIFEST_PATH = join(import.meta.dir, "..", "scripts", "rename-floka", "identifiers.json");
const full = (): Manifest => JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
function lone(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "floka-brand-inv-"));
  made.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
const scanOne = (body: string) => {
  const home = mkdtempSync(join(tmpdir(), "floka-brand-home-"));
  made.push(home);
  return runInventory(lone({ "web/sw.ts": `${body}\n` }), full(), { env: {}, home });
};

describe("正则前缀表：< 与展开运算符后面的 / 是正则，不是除号（MAP1 审查 P2 regex-prefix-gap）", () => {
  // 被当成除号时，正则里的引号开出一个假字符串，吞掉行尾注释：注释里的旧名被数成调用点
  const samples: [string, [number, number]][] = [
    ["const ok = n < /'/.test(s); // cstra_dev '", [1, 0]],
    ["const ok = [.../'/.exec(s)!]; // cstra_dev '", [1, 0]],
    ['const ok = n < /\'/.test(s); const c = "cstra_dev"; /* cstra_dev \' */', [2, 1]],
  ];
  for (const [line, want] of samples) {
    test(line, () => {
      const r = scanOne(line);
      expect(r.failures.map((f) => `${f.kind} ${f.detail}`)).toEqual([]);
      const cookie = r.identifiers.find((i) => i.id === "cookie.device")!;
      expect([cookie.textOccurrences, cookie.callSites]).toEqual(want);
    });
  }

  test("JSX 闭合标签 </x> 不是正则：同一行后面的标识照常计数", () => {
    const r = runInventory(lone({ "web/a.tsx": 'export const A = () => <b>x</b>; const c = "cstra_dev"; // </i>\n' }), full(), {
      env: {},
      home: lone({}),
    });
    const cookie = r.identifiers.find((i) => i.id === "cookie.device")!;
    expect([cookie.textOccurrences, cookie.callSites]).toEqual([1, 1]);
  });
});

describe("清单：负责卡是真实卡号，两条登记项按 PM 定稿", () => {
  test("没有「待建」占位，card 都以 rename-floka-<KEY><N> 开头", () => {
    const bad = full().identifiers.filter((it) => /待建/.test(it.card) || !/^rename-floka-[A-Z][A-Z0-9]*\d（阶段：.+）$/.test(it.card));
    expect(bad.map((it) => `${it.id} ${it.card}`)).toEqual([]);
  });

  test("runtime.tmux-ready-option：mechanical 只管新写入名，旧选项回落读取保留到 CLEAN1 验收", () => {
    const it = full().identifiers.find((x) => x.id === "runtime.tmux-ready-option")!;
    expect(it.exitEvidence).toContain("保留到 rename-floka-CLEAN1 验收为止");
    expect(it.compat).toContain("mechanical 只管新写入的选项名");
  });

  test("wire.e2e-labels：三个 peer 标签双认、新名 floka-peer-*；cstra-e2e-v1 另议", () => {
    const it = full().identifiers.find((x) => x.id === "wire.e2e-labels")!;
    expect(it.compat.startsWith("dual-accept")).toBe(true);
    for (const n of ["floka-peer-e2e-v1", "floka-peer-redeem-v1", "floka-peer-redeem-response-v1"]) expect(it.new).toContain(n);
    expect(it.new).toContain("cstra-e2e-v1（设备侧）另议");
  });
});
