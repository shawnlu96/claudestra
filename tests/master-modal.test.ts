/**
 * launcher 常驻循环对大总管的切模型 / effort 确认框：不按（T41a r4 P1-1），通知由 permission-watcher 发。真实 CC 2.1.280 原屏。
 * 大总管窗口身份核对（T41c r2 P1-3）：window 0 被 agent 占着时，watcher 不报、斜杠 / 设置不发键。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMasterWindowMeta, masterShouldAutoConfirm } from "../src/lib/master-modal.js";

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

describe("isMasterWindowMeta（窗口名 + pane 目录，同 launcher ensureMasterAtZero）", () => {
  const dir = mkdtempSync(join(tmpdir(), "t41c-master-"));
  const link = join(mkdtempSync(join(tmpdir(), "t41c-link-")), "m");
  symlinkSync(dir, link);

  test("大总管正身：名字不是 agent-*、目录就是 MASTER_DIR（软链对齐）", () => {
    expect(isMasterWindowMeta(`master\t${dir}`, dir)).toBe(true);
    expect(isMasterWindowMeta(`claude\t${link}\n`, dir)).toBe(true);
  });

  test("window 0 被 agent 抢占 / 目录不对 / 问不到 → 不是", () => {
    expect(isMasterWindowMeta(`agent-worker\t${dir}`, dir)).toBe(false);
    expect(isMasterWindowMeta("agent-worker\t/tmp/w", dir)).toBe(false);
    expect(isMasterWindowMeta("master\t/tmp/w", dir)).toBe(false);
    expect(isMasterWindowMeta("", dir)).toBe(false);
    expect(isMasterWindowMeta("master", dir)).toBe(false);
  });
});
