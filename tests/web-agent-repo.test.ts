/** web/features/chat/agent-repo.ts：侧栏 agent 后面的「所在仓」短名 */
import { describe, expect, test } from "bun:test";
import { agentRepoLabel, repoTagFits } from "@/features/chat/agent-repo";

const a = (name: string, cwd: string, label: string | null = null) => ({ name: `agent-${name}`, displayName: name, label, cwd });
const QN = ["/r/qingniao-miniapp", "/r/qingniao-backend"];

describe("agentRepoLabel", () => {
  test("单目录 project / 没有 project：不显示", () => {
    expect(agentRepoLabel(a("reviewer", "/r/x"), ["/r/x"])).toBeNull();
    expect(agentRepoLabel(a("reviewer", "/r/x"), undefined)).toBeNull();
  });
  test("多目录 project：显示最具体的那个仓的目录名", () => {
    expect(agentRepoLabel(a("reviewer", "/r/qingniao-backend/src"), QN)).toBe("qingniao-backend");
    expect(agentRepoLabel(a("tester", "/r/qingniao-miniapp"), [...QN, "/r"])).toBe("qingniao-miniapp");
  });
  test("名字 / 显示名里已经带仓名：不重复（现在的 qingniao-backend、router 都是这样）", () => {
    expect(agentRepoLabel(a("qingniao-backend", "/r/qingniao-backend"), QN)).toBeNull();
    expect(agentRepoLabel(a("x1", "/r/qingniao-backend", "Qingniao-Backend 助手"), QN)).toBeNull();
  });
  test("cwd 不在任何目录下（显式 --project 指到别处）：用 cwd 自己的目录名", () => {
    expect(agentRepoLabel(a("reviewer", "/elsewhere/tool/"), QN)).toBe("tool");
  });
  test("侧栏放不下名字 + 小标就不标（alipan-resource + ali-operate 超了）", () => {
    expect(repoTagFits("reviewer", "qingniao-backend")).toBe(true);
    expect(repoTagFits("alipan-resource", "ali-operate")).toBe(false);
  });
});
