/**
 * 收编已有会话时，cwd → agent 名的推导（v2.24+）。
 *
 * agent 名会直接拼进 tmux window 名、Discord 频道名和文件路径，仓库对它有校验
 * （不许空白 / shell 元字符 / 路径分隔符，长度有上限）。装机时是**批量**生成的，
 * 一条不合法就是一次失败的收编，所以这里把边界情况钉住。
 */
import { describe, test, expect } from "bun:test";
import { agentNameFromDir } from "../src/lib/agent-name.js";

const none = () => new Set<string>();

describe("agentNameFromDir", () => {
  test("取目录最后一段", () => {
    expect(agentNameFromDir("/Users/x/repos/bn_market_maker", none())).toBe("bn_market_maker");
  });

  test("统一小写（tmux window 名大小写敏感，注册与查找会对不上）", () => {
    expect(agentNameFromDir("/Users/x/MyProject", none())).toBe("myproject");
  });

  test("空格与 shell 元字符替换成连字符", () => {
    expect(agentNameFromDir("/Users/x/my project (old)", none())).toBe("my-project-old");
    expect(agentNameFromDir("/Users/x/a;rm -rf b", none())).toBe("a-rm--rf-b");
  });

  test("CJK 目录名保留（历史 agent 一直允许中文名）", () => {
    expect(agentNameFromDir("/Users/x/青鸟后端", none())).toBe("青鸟后端");
  });

  test("重名自动加序号", () => {
    const taken = new Set(["web"]);
    expect(agentNameFromDir("/Users/x/web", taken)).toBe("web-2");
    taken.add("web-2");
    expect(agentNameFromDir("/Users/x/web", taken)).toBe("web-3");
  });

  test("尾部斜杠不影响取名", () => {
    expect(agentNameFromDir("/Users/x/repos/api/", none())).toBe("api");
  });

  test("退化情形有兜底，不会产出空名", () => {
    expect(agentNameFromDir("/", none())).toBe("session");
    expect(agentNameFromDir("/Users/x/___", none())).toBe("___");
    expect(agentNameFromDir("/Users/x/...", none())).toBe("session");
  });

  test("超长目录名截断到 40 字符以内（上限 48，留出 -NN 后缀余量）", () => {
    const n = agentNameFromDir("/Users/x/" + "a".repeat(80), none());
    expect(n.length).toBeLessThanOrEqual(40);
  });
});
