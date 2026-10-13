/** BGW-1：restart-all 每轮日志开始行记调用者（principal id / token 名） */
import { expect, test } from "bun:test";
import { restartAllLabel } from "../src/lib/restart-all-caller.ts";
import { loggedRunScript } from "../src/lib/run-log.ts";

test("label 带 principal id 与名字，原有 flag 不变", () => {
  expect(restartAllLabel(" --include-master", { id: "token:tok_ab12", name: "web-owner" })).toBe("restart-all --include-master by token:tok_ab12 name:web-owner");
  expect(restartAllLabel("", { id: "discord:123" })).toBe("restart-all by discord:123");
});

test("名字里 shell / 非 ASCII 字符换成 _，过 loggedRunScript 的 label 校验；没有调用者记 unknown", () => {
  const label = restartAllLabel("", { id: "token:tok_x", name: "老板 $(rm -rf ~);`x`" });
  expect(label).toMatch(/^[\w .:-]+$/);
  expect(label).toContain("by token:tok_x name:");
  expect(restartAllLabel("", null)).toBe("restart-all by unknown");
});

test("开始行（日志首行）就是带调用者的那行", () => {
  const script = loggedRunScript({ runId: "1791426816915", label: restartAllLabel(" --include-master", { id: "token:tok_ab12", name: "web" }), cmd: "true", log: "/dev/null" });
  expect(script).toContain('echo "=== run:1791426816915 $(date \'+%F %T\') restart-all --include-master by token:tok_ab12 name:web ==="');
});
