import { expect, test } from "bun:test";
import { parseFailedLog } from "../src/lib/scheduler-merge-ci-rerun-log.js";

const hooks = (total = 3, extra = false) => [
  "##[group]tests/a.test.ts:", "error: import failed", "(fail) (unnamed)",
  "error: TypeError", "##[error]afterAll failed", "(fail) (unnamed)", ...(extra ? ["error: unclaimed"] : []), "##[endgroup]",
  "##[group]tests/b.test.ts:", "error: Failed to register", "##[error]registration failed", "(fail) (unnamed)", "##[endgroup]",
  "(fail) (unnamed)", "(fail) (unnamed)", "(fail) (unnamed)", ` ${total} fail`, "##[error]Process completed with exit code 1.",
].join("\n");
test("[验收线 1] repeated beforeAll / afterAll failures each claim their errors", () => {
  expect(parseFailedLog(hooks())).toEqual([
    { file: "tests/a.test.ts", name: "(unnamed)", timedOut: false },
    { file: "tests/a.test.ts", name: "(unnamed)", timedOut: false },
    { file: "tests/b.test.ts", name: "(unnamed)", timedOut: false },
  ]);
});
test("[验收线 1] repeated names still require exact totals and all errors claimed", () => {
  expect(parseFailedLog(hooks(2))).toBeNull();
  expect(parseFailedLog(hooks(3, true))).toBeNull();
  expect(parseFailedLog("##[group]tests/a.test.ts:\n(fail) same\n(fail) same\n##[endgroup]\n 1 fail")).toBeNull();
});
test("[验收线 1] repeated names keep each occurrence's own timeout evidence", () => {
  const log = ["##[group]tests/a.test.ts:", "(fail) same", "^ this test timed out after 5000ms.", "error: assertion",
    "(fail) same", "##[endgroup]", "(fail) same", "(fail) same", " 2 fail"].join("\n");
  expect(parseFailedLog(log)).toEqual([
    { file: "tests/a.test.ts", name: "same", timedOut: true }, { file: "tests/a.test.ts", name: "same", timedOut: false },
  ]);
});
