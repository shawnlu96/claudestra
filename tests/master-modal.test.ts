/**
 * launcher 常驻循环对大总管的切模型 / effort 确认框：不按（T41a r4 P1-1），通知由 permission-watcher 发。真实 CC 2.1.280 原屏。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { masterShouldAutoConfirm } from "../src/lib/master-modal.js";

const fx = (f: string): string => readFileSync(join(import.meta.dir, "fixtures", "switch-confirm", f), "utf8");
const last10 = (pane: string) => pane.replace(/\s+$/, "").split("\n").slice(-10).join("\n");
const SWITCH_MODEL = fx("cc2.1.280-switch-model.txt");
const CHANGE_EFFORT = fx("cc2.1.280-change-effort.txt");

describe("masterShouldAutoConfirm", () => {
  test("launcher 抓的最后 10 行停在切模型 / effort 框上 → 不代按", () => {
    expect(masterShouldAutoConfirm(last10(SWITCH_MODEL))).toBe(false);
    expect(masterShouldAutoConfirm(last10(CHANGE_EFFORT))).toBe(false);
  });
});
