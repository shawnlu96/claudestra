import { describe, expect, test } from "bun:test";
import { schedulerVerifyRepo } from "../src/lib/scheduler-verify-gate.js";

describe("[验收线 2] verification repository selection", () => {
  const read = () => ({ projects: { peer: { repoDir: "/project/repo" }, deployed: { repoDir: "/deployed", deploy: {} } } });
  test("proven peer imports use their project repository without requiring automatic deployment", () => {
    expect(schedulerVerifyRepo("peer", read, true)).toBe("/project/repo");
    expect(schedulerVerifyRepo("missing", read, true)).toBeNull();
  });
  test("ordinary cards still require deployed repository configuration", () => {
    expect(schedulerVerifyRepo("peer", read)).toBeNull();
    expect(schedulerVerifyRepo("deployed", read)).toBe("/deployed");
  });
});
