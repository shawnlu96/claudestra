/**
 * 终端截图：tmux capture-pane (ANSI) → ansi2html → Playwright PNG
 */

import { TMUX_SOCK, BUN_PATH, ENV_WITH_BUN, TMP_DIR } from "./config.js";

export async function tmuxScreenshot(
  windowName: string
): Promise<string | null> {
  const pngPath = `${TMP_DIR}/peek_${windowName}_${Date.now()}.png`;
  const target =
    windowName === "master" ? "master:0" : `master:${windowName}`;

  try {
    const htmlPath = `${TMP_DIR}/peek_${Date.now()}.html`;
    const srcDir = import.meta.dir + "/..";

    // capture with ANSI colors → pipe to ansi2html
    const capture = Bun.spawn(
      [
        "tmux", "-S", TMUX_SOCK,
        "capture-pane", "-t", target,
        "-p", "-e", "-S", "-50",
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const ansi2html = Bun.spawn(
      [BUN_PATH, "run", `${srcDir}/ansi2html.ts`, htmlPath],
      { stdin: capture.stdout, stdout: "pipe", stderr: "pipe", env: ENV_WITH_BUN }
    );
    await ansi2html.exited;

    // HTML → PNG
    const renderProc = Bun.spawn(
      [BUN_PATH, "run", `${srcDir}/html2png.ts`, htmlPath, pngPath, "1200"],
      { stdout: "pipe", stderr: "pipe", env: ENV_WITH_BUN }
    );
    const renderErrPromise = new Response(renderProc.stderr).text();
    await renderProc.exited;

    const { existsSync } = await import("fs");
    try {
      await Bun.spawn(["rm", htmlPath]).exited;
    } catch { /* non-critical */ }
    if (existsSync(pngPath)) return pngPath;

    // v2.5.4+ PNG 没出来 → 把 html2png 的 stderr 记进日志。之前静默吞掉，像
    // Playwright chromium 缓存被清（系统清理工具清 ~/Library/Caches）这种环境级
    // 故障完全无迹可查。缺 chromium 时顺便给出可操作的修复命令。
    const errText = (await renderErrPromise).trim();
    if (errText) {
      const missingChromium = /Executable doesn't exist|playwright install/i.test(errText);
      console.error(
        `📸 html2png 失败 (${windowName}):`,
        errText.split("\n").slice(0, 3).join(" | ").slice(0, 300),
        missingChromium ? "→ 修复: bun node_modules/playwright-core/cli.js install chromium-headless-shell" : ""
      );
    }
  } catch (e) {
    console.error(`📸 tmuxScreenshot 异常 (${windowName}):`, (e as Error).message);
  }

  return null;
}
