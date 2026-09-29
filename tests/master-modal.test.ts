/**
 * launcher 常驻循环对大总管的切模型 / effort 确认框：不按，只提醒（T41a r4 P1-1）。真实 CC 2.1.280 原屏。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSwitchBoxNotifier, masterShouldAutoConfirm } from "../src/lib/master-modal.js";

const fx = (f: string): string => readFileSync(join(import.meta.dir, "fixtures", "switch-confirm", f), "utf8");
const last10 = (pane: string) => pane.replace(/\s+$/, "").split("\n").slice(-10).join("\n");
const SWITCH_MODEL = fx("cc2.1.280-switch-model.txt");
const CHANGE_EFFORT = fx("cc2.1.280-change-effort.txt");
const IDLE = fx("cc2.1.280-model-set.txt");

describe("masterShouldAutoConfirm", () => {
  test("launcher 抓的最后 10 行停在切模型 / effort 框上 → 不代按", () => {
    expect(masterShouldAutoConfirm(last10(SWITCH_MODEL))).toBe(false);
    expect(masterShouldAutoConfirm(last10(CHANGE_EFFORT))).toBe(false);
  });
});

describe("createSwitchBoxNotifier", () => {
  function setup() {
    const sent: string[] = [];
    return { sent, check: createSwitchBoxNotifier(async (t) => { sent.push(t); }) };
  }

  test("同一张框连续两轮才提醒、只提醒一次", async () => {
    const { sent, check } = setup();
    await check(last10(SWITCH_MODEL));
    expect(sent).toEqual([]);
    await check(last10(SWITCH_MODEL));
    await check(last10(SWITCH_MODEL));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Sonnet 5");
  });

  test("框只出现一轮就被按掉（网页设置自己那张）→ 不提醒", async () => {
    const { sent, check } = setup();
    await check(last10(SWITCH_MODEL));
    await check(last10(IDLE));
    await check(last10(IDLE));
    expect(sent).toEqual([]);
  });

  test("框关了又弹一张 → 重新计数，再提醒一次", async () => {
    const { sent, check } = setup();
    for (const p of [SWITCH_MODEL, SWITCH_MODEL, IDLE, CHANGE_EFFORT, CHANGE_EFFORT]) await check(last10(p));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("high");
  });
});
