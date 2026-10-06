import { describe, expect, test } from "bun:test";
import { buildAcpHostCommand } from "../src/lib/runtimes/codex-acp.ts";
import { buildPiAcpHostCommand } from "../src/lib/runtimes/pi-acp.ts";
import type { LaunchSpec } from "../src/lib/runtimes/types.ts";
import { cardContextFromEnv } from "../src/lib/acp/host.ts";
import { testChildEnv } from "./test-env.ts";

// CTXA 启动接线：create --card → prepareSession 后的实际会话 → LaunchSpec.card → 两种 ACP 启动命令的两个 env pair → 宿主 cardContextFromEnv。
// 只调两个规范的纯命令生成器、不执行命令；env 用干净的假环境（不读生产、不起进程）。

const SID = "019a0000-0000-7000-8000-0000000c7a01";
const env = { PATH: "/usr/bin", HOME: "/tmp/ctxa-launch-home" };
const spec = (over: Partial<LaunchSpec> = {}): LaunchSpec =>
  ({ mode: "new", channelId: "local-ctxa", bridgeUrl: "http://127.0.0.1:1", sessionId: SID, agentName: "ctxa-worker", cwd: "/tmp", ...over });
const builders = {
  codex: (s: LaunchSpec) => buildAcpHostCommand(s, { bunBin: "/bin/bun", repoRoot: "/repo", env }),
  pi: (s: LaunchSpec) => buildPiAcpHostCommand(s, { bunBin: "/bin/bun", repoRoot: "/repo", env }),
};

/** 照 shell 的单引号规则从命令里取 KEY=值（只认生成器的 shellEscape 输出形状） */
function envOf(cmd: string, key: string): string | undefined {
  const m = cmd.match(new RegExp(`(?:^|\\s)${key}=((?:'[^']*'|\\\\'|[^\\s'])+)`));
  return m ? m[1].replace(/'\\''/g, "'").replace(/^'|'$/g, "").replace(/\\'/g, "'") : undefined;
}

describe.each(Object.entries(builders))("%s ACP 启动命令", (_, build) => {
  test("带 card：两个 env pair 原样带上实际会话；和 CLAUDESTRA_SESSION_ID 同一个会话共存；宿主读得回同一身份", () => {
    const cmd = build(spec({ card: { id: "CTXA", sessionId: SID } }));
    expect(envOf(cmd, "CLAUDESTRA_ACP_CARD")).toBe("CTXA");
    expect(envOf(cmd, "CLAUDESTRA_ACP_CARD_SESSION")).toBe(SID);
    expect(envOf(cmd, "CLAUDESTRA_SESSION_ID")).toBe(SID);
    expect(cardContextFromEnv({ CLAUDESTRA_ACP_CARD: envOf(cmd, "CLAUDESTRA_ACP_CARD"), CLAUDESTRA_ACP_CARD_SESSION: envOf(cmd, "CLAUDESTRA_ACP_CARD_SESSION") }))
      .toEqual({ card: "CTXA", expectedSessionId: SID });
  });

  test("不带 card（老 create / resume / 非卡片）：命令里没有卡片 env，和原来逐字相同；宿主无身份", () => {
    const cmd = build(spec());
    expect(cmd).not.toContain("CLAUDESTRA_ACP_CARD");
    expect(cardContextFromEnv({ CLAUDESTRA_SESSION_ID: SID })).toBeUndefined();
  });

  test("卡号带 shell 特殊字符：照样转义成一个词（不拆、不注入）", () => {
    const cmd = build(spec({ card: { id: "a'b c;$x", sessionId: SID } }));
    // 把命令尾部的宿主换成 printf 环境变量，交给真 sh 解析前缀（只读环境，不起宿主）
    const probe = cmd.slice(0, cmd.lastIndexOf(" /bin/bun ")) + ` /bin/sh -c 'printf "%s\\n%s\\n" "$CLAUDESTRA_ACP_CARD" "$CLAUDESTRA_ACP_CARD_SESSION"'`;
    const out = Bun.spawnSync(["/bin/sh", "-c", probe], { env: testChildEnv() });
    expect(out.stdout.toString()).toBe(`a'b c;$x\n${SID}\n`);
  });
});
