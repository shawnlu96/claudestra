/**
 * 终端截图：tmux capture-pane (ANSI) → ansi2html → Playwright PNG
 */

import { TMUX_SOCK, BUN_PATH, ENV_WITH_BUN } from "./config.js";

export async function tmuxScreenshot(
  windowName: string
): Promise<string | null> {
  const pngPath = `/tmp/claude-orchestrator/peek_${windowName}_${Date.now()}.png`;
  const target =
    windowName === "master" ? "master:0" : `master:${windowName}`;

  try {
    const htmlPath = `/tmp/claude-orchestrator/peek_${Date.now()}.html`;
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
    await renderProc.exited;

    const { existsSync } = await import("fs");
    try {
      await Bun.spawn(["rm", htmlPath]).exited;
    } catch {}
    if (existsSync(pngPath)) return pngPath;
  } catch {}

  return null;
}
