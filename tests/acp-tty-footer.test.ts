import { expect, test } from "bun:test";
import { createTtyScreen } from "../src/lib/acp/tty-screen.ts";
import { fitWidth, foldsOf, statusText, type TurnState } from "../src/lib/acp/tty-status.ts";
import { termText } from "./helpers/acp-tty-term.ts";

// 接了输入行：底栏两行（状态 + 输入），内容写在上面；输入变了重画；变窄时两行各自的折行都擦掉

const IDLE: TurnState = { busy: false, queued: 0, permissions: 0 };

function screen(cols = 40) {
  const st = { state: { ...IDLE }, cols, out: "", input: "❯ " };
  const s = createTtyScreen({ write: (x) => void (st.out += x), columns: () => st.cols }, () => st.state, () => 0, () => st.input);
  return { st, s, view: () => termText(st.out) };
}

test("底栏两行：内容插在状态行上面，输入行永远在最后；打字后 tick 重画输入行", () => {
  const { st, s, view } = screen();
  s.print("第一段");
  expect(view()).toBe("第一段\n· 空闲\n❯ ");
  st.input = "❯ 你好";
  s.tick();
  expect(view()).toBe("第一段\n· 空闲\n❯ 你好");
  s.print("第二段");
  expect(view()).toBe("第一段\n第二段\n· 空闲\n❯ 你好");
  s.close(); // 两行底栏都擦掉；光标回到原状态行行首，shell 提示符从那里接
  expect(view().trimEnd()).toBe("第一段\n第二段");
});

test("变窄：状态行和输入行各自被折的行都擦掉，再画截短的两行", () => {
  const { st, s } = screen(40);
  st.state = { busy: true, queued: 3, permissions: 0 };
  st.input = `❯ ${"x".repeat(30)}`;
  s.tick();
  const [oldStatus, oldInput] = [statusText(st.state, 0), st.input];
  st.cols = 12;
  st.input = "❯ xx";
  const mark = st.out.length;
  s.resize();
  const up = 1 + foldsOf(fitWidth(oldStatus, 40), 12) + foldsOf(oldInput, 12);
  expect(st.out.slice(mark)).toBe(`\r\x1b[2K${"\x1b[1A\x1b[2K".repeat(up)}${fitWidth(oldStatus, 12)}\n❯ xx`);
});

test("没接输入行（非交互 / 出借 worker）：底栏照旧一行", () => {
  const st = { out: "" };
  const s = createTtyScreen({ write: (x) => void (st.out += x), columns: () => 40 }, () => IDLE, () => 0);
  s.print("段");
  expect(termText(st.out)).toBe("段\n· 空闲");
});
