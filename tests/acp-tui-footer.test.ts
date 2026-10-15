import { expect, test } from "bun:test";
import { inputBox } from "../src/lib/acp/tui/footer.ts";
import { createTuiScreen } from "../src/lib/acp/tui/screen.ts";
import { createTtyInput } from "../src/lib/acp/tty-input.ts";

// 输入框也是显示内容：草稿和审批提示先整段打码，再折行、裁剪行数（PR1546-r1 P1 input-draft-unredacted）

const VALUE = "Sup3rS3cretValue9";

test("输入框：草稿里的凭据打码（单行、换行隔开、超过 6 行被裁剪的都不漏）", () => {
  for (const text of [`password=${VALUE}`, `password=\n\n\n${VALUE}`, `${"行\n".repeat(10)}token: ${VALUE}`]) {
    expect(inputBox({ text, permission: null }, 80).join("\n")).not.toContain(VALUE);
  }
});

test("输入框：审批提示同样打码", () => {
  expect(inputBox({ text: "", permission: `审批 [1]允许 password=${VALUE}` }, 80).join("\n")).not.toContain(VALUE);
});

test("屏幕：正在打的草稿经底栏写到终端的字节里没有明文", () => {
  let out = "";
  const draft = { text: `curl -H 'Authorization: Bearer ${VALUE}${VALUE}'`, permission: null };
  const s = createTuiScreen({ write: (x) => void (out += x), columns: () => 60 }, () => ({ busy: false, queued: 0, permissions: 0 }), () => 0, () => draft);
  s.tick();
  draft.text = `password=${VALUE}`;
  s.tick();
  expect(out).not.toContain(VALUE);
  expect(out).toContain("[redacted]");
});

test("逐行视图（兜底）的输入行也打码；发出去的仍是原文", async () => {
  const sent: string[] = [];
  const input = createTtyInput({ busy: () => false, permission: () => null, request: async (op) => (op.op === "message" && sent.push(op.text), { ok: true }),
    print: () => {}, redraw: () => {}, exit: () => {} });
  input.feed(`password=${VALUE}`);
  expect(input.line(80)).not.toContain(VALUE);
  input.feed("\r");
  await Bun.sleep(0);
  expect(sent).toEqual([`password=${VALUE}`]);
});
