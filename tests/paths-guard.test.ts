/**
 * 守门：状态目录 / 运行目录 / 默认端口的字面量只允许出现在定义处（lib/paths.ts、
 * lib/bridge-url.ts）和下面列明理由的文件里。新代码要路径就 import lib/paths，要端口就
 * import DEFAULT_BRIDGE_PORT —— 否则 CLAUDESTRA_STATE_DIR / CLAUDESTRA_RUNTIME_DIR 这两个
 * override 会在新代码里悄悄失效，沙箱又开始写生产目录（2026-09 审查 D7-9 / D7-8）。
 *
 * 注释行不算（`//`、`*`、`/*` 开头）。白名单是「允许」不是「必须」：文件里的字面量被清掉后
 * 这里不会失败，顺手把对应条目删掉即可。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC = join(import.meta.dir, "../src");
const LITERAL = /\.claude-orchestrator|\/tmp\/claude-orchestrator|master\.sock|\b3847\b/;

const ALLOW: Record<string, string> = {
  "lib/paths.ts": "定义处",
  "lib/bridge-url.ts": "DEFAULT_BRIDGE_PORT 定义处",
  "pi/claudestra-extension.ts": "Pi 扩展只依赖 node: 模块，内联了 paths.ts 的同一条规则",
  "lib/channel-instructions.ts": "给 agent 看的说明文字（~ 路径是给人读的）",
  "channel-server.ts": "给 agent 看的说明文字（归 P3b）",
  "setup.ts": "安装完成后打印的提示文字",
  "lib/codex.ts": "codex-threads.json 路径，待随 codex 相关文件一起收口",
  "bridge.ts": "registry 同步读 / msg-source.json，待 P10 改用 readRegistryAgentsSync / statePath",
  "bridge/api-routes.ts": "日志路径与 peer 端口默认值，待 P10 改用 LOG_DIR / DEFAULT_BRIDGE_PORT",
};

function offenders(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!p.endsWith(".ts")) continue;
      const rel = relative(SRC, p);
      if (rel in ALLOW) continue;
      readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
        if (LITERAL.test(line)) out.push(`${rel}:${i + 1}: ${t.slice(0, 120)}`);
      });
    }
  };
  walk(SRC);
  return out;
}

describe("路径 / 端口字面量守门", () => {
  test("只出现在 lib/paths.ts、lib/bridge-url.ts 与白名单文件里", () => {
    expect(offenders()).toEqual([]);
  });
});
