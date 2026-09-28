/**
 * 撞额度菜单上一个键都不发（T24）：launcher 的自动确认（lib/tmux-helper.ts isAutoConfirmableModal）、打字前的画面检查
 * （lib/wall-screen.ts）都认 lib/limit-menu.ts 的宽松菜单判定。样本 tests/fixtures/quota-wall/。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAutoConfirmableModal } from "../src/lib/tmux-helper.js";

describe("额度菜单不自动确认（T24 wf keys-screens-3：launcher 每 15 秒对 master 按 Enter 会替人选中高亮项）", () => {
  test("4 张真实菜单（含高亮停在 Switch to usage credits 上的）：launcher / 就绪轮询都不按", () => {
    for (const f of ["menu-no-lp", "menu-on-lp", "menu-5-items", "menu-on-credits", "menu-narrow60"]) {
      const pane = readFileSync(join(import.meta.dir, "fixtures/quota-wall", `${f}.txt`), "utf8");
      expect([f, isAutoConfirmableModal(pane), isAutoConfirmableModal(pane, { allowSessionIdle: true })]).toEqual([f, false, false]);
    }
  });
});
