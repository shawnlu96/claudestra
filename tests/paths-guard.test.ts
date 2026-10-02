/**
 * 守门：状态目录 / 运行目录 / 默认端口的字面量只允许出现在定义处（lib/paths.ts、
 * lib/bridge-url.ts）和下面列明理由的文件里。新代码要路径就 import lib/paths，要端口就
 * import DEFAULT_BRIDGE_PORT —— 否则 CLAUDESTRA_STATE_DIR / CLAUDESTRA_RUNTIME_DIR 这两个
 * override 会在新代码里悄悄失效，沙箱又开始写生产目录（2026-09 审查 D7-9 / D7-8）。
 * 扫 src/ 的 .ts 与 scripts/ 的 .ts / .sh：scripts 里的 statusLine 落盘脚本曾写死生产目录，
 * 沙箱 agent 一刷新状态栏就写生产（T1 复核）。
 *
 * 注释行不算（`//`、`*`、`/*`、`#` 开头）。白名单是「允许」不是「必须」：文件里的字面量被清掉后
 * 这里不会失败，顺手把对应条目删掉即可。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const REPO = join(import.meta.dir, "..");
const LITERAL = /\.claude-orchestrator|\/tmp\/claude-orchestrator|master\.sock|\b3847\b/;

const ALLOW: Record<string, string> = {
  "src/lib/paths.ts": "定义处",
  "src/lib/bridge-url.ts": "DEFAULT_BRIDGE_PORT 定义处",
  "src/pi/claudestra-extension.ts": "Pi 扩展只依赖 node: 模块，内联了 paths.ts 的同一条规则",
  "src/lib/state-dir.ts": "状态目录定义处（只依赖 node: 模块，供 Pi 扩展安全 import；paths.ts 复用）",
  "src/lib/channel-instructions.ts": "给 agent 看的说明文字（~ 路径是给人读的）",
  "src/channel-server.ts": "给 agent 看的说明文字（归 P3b）",
  "src/setup.ts": "安装完成后打印的提示文字",
  "scripts/web-only-bridge.sh": "生产 launchd 包装器，就是给生产实例用的",
  "scripts/web-diag.sh": "生产诊断脚本，只读生产日志",
  "scripts/renew-ts-cert.ts": "生产 TLS 续签（launchd），证书就在生产目录",
};

/**
 * 按行放行：这些文件整体仍受检，只有「同一行也出现了覆盖变量」的字面量才算默认值兜底。
 * usage-cache-write.sh 正是写死生产目录出过事的那个文件，不能整文件放行（T1 复核第 2 轮）。
 */
const LINE_ALLOW: Record<string, RegExp> = {
  "scripts/usage-cache-write.sh": /CLAUDESTRA_STATE_DIR/,
};

/** 这一行算不算违规（纯函数，下面有回退用例）。`#` 注释只在 .sh 里跳过——.ts 里 `#field` 是私有字段 */
function lineOffends(rel: string, line: string): boolean {
  if (rel in ALLOW) return false;
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
  if (rel.endsWith(".sh") && t.startsWith("#")) return false;
  if (!LITERAL.test(line)) return false;
  return !LINE_ALLOW[rel]?.test(line);
}

function offenders(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(ts|sh)$/.test(p)) continue;
      const rel = relative(REPO, p);
      readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        if (lineOffends(rel, line)) out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
  };
  walk(join(REPO, "src"));
  walk(join(REPO, "scripts"));
  return out;
}

describe("路径 / 端口字面量守门", () => {
  test("只出现在 lib/paths.ts、lib/bridge-url.ts 与白名单文件里（src/ 与 scripts/）", () => {
    expect(offenders()).toEqual([]);
  });
  test("usage-cache-write.sh 只按行放行：写死生产目录的行照样拦（撤掉按行规则、改回整文件放行会红）", () => {
    const f = "scripts/usage-cache-write.sh";
    expect(lineOffends(f, 'cache_dir = os.path.expanduser("~/.claude-orchestrator")')).toBe(true);
    expect(lineOffends(f, 'cache_dir = os.environ.get("CLAUDESTRA_STATE_DIR", "").strip() or os.path.expanduser("~/.claude-orchestrator")')).toBe(false);
    expect(lineOffends(f, "# 默认 ~/.claude-orchestrator")).toBe(false);
  });
  test("# 开头只在 .sh 里算注释：.ts 的私有字段照样查", () => {
    expect(lineOffends("src/x.ts", '#dir = "/tmp/claude-orchestrator";')).toBe(true);
    expect(lineOffends("scripts/x.sh", "# /tmp/claude-orchestrator")).toBe(false);
  });
});
