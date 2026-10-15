/**
 * ACP 终端视图前后对比截图（ATUI-1 交付证据，全程无头，不碰 owner 的屏幕）：
 * 在私有 tmux 服务器（-L）里按给定宽高跑本脚本的演示模式（--demo，见 demo()），capture-pane -e 取带颜色的整屏，
 * 再用无头 Chrome 里的 xterm.js 原样画出来截图。画面经过真 tmux，控制序列、宽字、折行都是真的。
 * 用法：bun run tui-shots <输出目录> [52x44 120x44 …] [--variants before,after] [--views home,busy] [--pane <tmux 目标>]
 * --pane：不起演示，直接截一个已有的 pane（沙箱实测用；配合 TMUX_SOCKET=<socket 路径>）。需要本机 Chrome（或 CHROME_PATH）。
 * 演示：bun scripts/acp-tui-shots.ts --demo before|after home|busy——在当前终端里画同一轮会话夹具（tests/helpers/acp-tui-session.ts），
 * before = 逐行视图 tty-screen.ts，after = 新视图 tui/screen.ts；home = 整轮结束，busy = 回合进行中。画完停着，窗口改尺寸照宿主一样重画。
 */
import { chromium, type Browser } from "playwright-core";
import { join } from "node:path";
import { createTuiScreen } from "../src/lib/acp/tui/screen.ts";
import { createTtyScreen, type TtyScreen } from "../src/lib/acp/tty-screen.ts";
import type { TurnState } from "../src/lib/acp/tty-status.ts";
import { CONFIG, playBusy, playSession } from "../tests/helpers/acp-tui-session.ts";

const XTERM = join(import.meta.dir, "..", "web", "node_modules", "@xterm", "xterm");
const MONO = '"SF Mono", Menlo, Monaco, "Cascadia Mono", "PingFang SC", monospace';
const SOCK = "atui-shots";

const tmux = (args: string[]) => {
  const sock = process.env.TMUX_SOCKET;
  const r = Bun.spawnSync(["tmux", ...(sock ? ["-S", sock] : ["-L", SOCK]), ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`tmux ${args.join(" ")}：${r.stderr.toString()}`);
  return r.stdout.toString();
};

/** 起演示、等它画完、取带颜色的整屏 */
async function captureDemo(variant: string, view: string, cols: number, rows: number): Promise<string> {
  Bun.spawnSync(["tmux", "-L", SOCK, "kill-server"], { stderr: "ignore" }); // 上一次没收干净的私有服务器：没有就算了
  tmux(["new-session", "-d", "-x", String(cols), "-y", String(rows), `bun ${import.meta.path} --demo ${variant} ${view}`]);
  await Bun.sleep(2_500);
  const text = tmux(["capture-pane", "-e", "-p"]);
  tmux(["kill-server"]);
  return text;
}

async function shoot(browser: Browser, text: string, cols: number, rows: number, file: string): Promise<void> {
  const page = await browser.newPage({ viewport: { width: Math.max(390, cols * 9 + 20), height: rows * 18 + 40 }, deviceScaleFactor: 2 });
  await page.setContent("<!doctype html><html><body style='margin:0;background:#1e1e2e'><div id=t style='padding:8px'></div></body></html>");
  await page.addStyleTag({ path: join(XTERM, "css", "xterm.css") });
  await page.addScriptTag({ path: join(XTERM, "lib", "xterm.js") });
  await page.evaluate(async ({ cols, rows, text, font }) => {
    const g = globalThis as any; // 页面里跑：xterm 的 UMD 挂在 window 上（根 tsconfig 不带 DOM 类型）
    const T = g.Terminal;
    const term = new T({ cols, rows, fontSize: 13, fontFamily: font, theme: { background: "#1e1e2e", foreground: "#cdd6f4" } });
    term.open(g.document.getElementById("t"));
    await new Promise<void>((res) => term.write(text, () => res()));
    await new Promise((r) => setTimeout(r, 300));
  }, { cols, rows, text: text.replace(/\n$/, "").replace(/\n/g, "\r\n"), font: MONO });
  await Bun.write(file, await page.locator(".xterm-screen").screenshot());
  await page.close();
}

/** 演示模式：不连 bridge、不起适配器，照宿主的顺序把夹具画进当前终端，然后停 30 秒等截图 */
function demo(variant: string, view: string): void {
  const io = { write: (s: string) => void process.stdout.write(s), columns: () => process.stdout.columns || 80, rows: () => process.stdout.rows || 40 };
  const busy = view === "busy";
  const state = (): TurnState => ({ busy, queued: busy ? 1 : 0, permissions: 0 });
  const draft = "帮我再看一下 LCK-1\n顺便把测试补上";
  process.stdout.write("\x1b[H\x1b[2J\x1b[3J");
  const screen: TtyScreen & { config?(raw: unknown): void } = variant === "before"
    ? createTtyScreen(io, state, Date.now, (cols) => `❯ ${draft.replace(/\n/g, "⏎")}`.slice(0, cols - 1))
    : createTuiScreen(io, state, Date.now, () => ({ text: draft, permission: null }));
  screen.config?.(CONFIG);
  if (busy) playBusy(screen);
  else playSession(screen);
  process.stdout.on("resize", () => screen.resize());
  setInterval(() => screen.tick(), 1_000);
  setTimeout(() => process.exit(0), 30_000);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const dir = args[0];
  if (!dir) throw new Error("用法：bun scripts/acp-tui-shots.ts <输出目录> [52x44 …] [--variants before,after] [--pane <目标>]");
  const sizes = args.filter((a) => /^\d+x\d+$/.test(a)).map((a) => a.split("x").map(Number) as [number, number]);
  const variants = (opt("--variants") ?? "before,after").split(",");
  const views = (opt("--views") ?? "home,busy").split(",");
  const pane = opt("--pane");
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  try {
    if (pane) {
      const [cols, rows] = tmux(["display", "-p", "-t", pane, "#{pane_width}x#{pane_height}"]).trim().split("x").map(Number) as [number, number];
      await shoot(browser, tmux(["capture-pane", "-e", "-p", "-t", pane]), cols, rows, join(dir, `${opt("--name") ?? "pane"}-${cols}x${rows}.png`));
      return;
    }
    for (const [cols, rows] of sizes.length ? sizes : [[52, 44], [120, 44]] as [number, number][]) {
      for (const view of views) {
        for (const v of variants) {
          const file = join(dir, `${v}-${view}-${cols}x${rows}.png`);
          await shoot(browser, await captureDemo(v, view, cols, rows), cols, rows, file);
          console.log(file);
        }
      }
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[2] === "--demo") demo(process.argv[3] ?? "after", process.argv[4] ?? "home");
else await main();
