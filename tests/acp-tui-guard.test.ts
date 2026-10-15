import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { guardScreen } from "../src/lib/acp/tui/guard.ts";
import { createTuiScreen, type TuiScreen } from "../src/lib/acp/tui/screen.ts";
import { createTtyScreen } from "../src/lib/acp/tty-screen.ts";
import type { TurnState } from "../src/lib/acp/tty-status.ts";
import { termText } from "./helpers/acp-tty-term.ts";

// 新视图出异常：记一条原因、擦掉新视图的底栏、退回逐行视图并重放这次调用——消息照收，宿主不退出

const IDLE: TurnState = { busy: false, queued: 0, permissions: 0 };
const at = new Date(2026, 9, 14, 12, 0, 0);

function rig(breakOn: (item: string) => boolean) {
  const st = { out: "", logs: [] as string[] };
  const io = { write: (x: string) => void (st.out += x), columns: () => 100 };
  const tui = (): TuiScreen => {
    const real = createTuiScreen(io, () => IDLE, () => 0);
    return { ...real, show: (item, when) => (breakOn(item) ? (() => { throw new Error("渲染炸了"); })() : real.show(item, when)) };
  };
  const s = guardScreen(tui, () => createTtyScreen(io, () => IDLE, () => 0), (m) => st.logs.push(m));
  return { st, s };
}

test("某一段渲染抛错：退回逐行视图，这段和之后的段照样显示，日志记原因", () => {
  const { st, s } = rig((i) => i.includes("炸"));
  s.show("> owner：先来一条", at);
  s.show("> owner：这条会炸", at);
  s.show("> owner：后面这条", at);
  expect(st.logs).toHaveLength(1);
  expect(st.logs[0]).toContain("ACP 终端新视图出错，退回逐行视图：Error: 渲染炸了");
  const screen = termText(st.out);
  expect(screen).toContain("┃ owner · 12:00\n┃ 先来一条"); // 新视图画的
  expect(screen).toContain("[12:00:00] > owner：这条会炸"); // 逐行视图重放的
  expect(screen).toContain("> owner：后面这条");
  expect(st.out).toContain("\x1b[?25h"); // 新视图收尾时把隐藏的光标还回去
});

test("新视图建不起来：一开始就用逐行视图", () => {
  const logs: string[] = [];
  let out = "";
  const s = guardScreen(() => { throw new Error("建不起来"); }, () => createTtyScreen({ write: (x) => void (out += x), columns: () => 100 }, () => IDLE), (m) => logs.push(m));
  s.show("> owner：hi", at);
  expect(logs[0]).toContain("建不起来");
  expect(termText(out)).toContain("[12:00:00] > owner：hi");
});

test("宿主入口：TTY 走新视图（带保险），CLAUDESTRA_ACP_TUI=0 走逐行视图，非 TTY 照旧纯文本", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "acp-host.ts"), "utf8");
  expect(src).toContain('process.env.CLAUDESTRA_ACP_TUI === "0" ? lineView()');
  expect(src).toContain("guardScreen(() => createTuiScreen(");
  expect(src).toContain("const show = (item: string) => (tty ? tty.show(item) : console.log(stampTranscript(item)));");
});
