import type { WindowOps } from "./runtimes/types.js";

function trustTail(pane: string): string[] {
  return pane.trimEnd().split("\n").slice(-25);
}

/** The title is drawn before the options/footer, so it must block generic Enter even during rendering. */
export function hasTrustPromptMarker(pane: string): boolean {
  return /trust this folder|Quick safety check|Do you trust the files/i.test(trustTail(pane).join("\n"));
}

/** Owner-selected launch directories retain automatic trust; moves navigate to Yes instead of accepting No. */
export function trustPromptMoves(pane: string): number | null {
  if (!hasTrustPromptMarker(pane)) return null;
  const opts: Array<{ yes: boolean; selected: boolean }> = [];
  for (const raw of trustTail(pane)) {
    const m = raw.match(/^\s*(❯)?\s*(?:\d+\.\s*)?((?:No|Yes|Exit|Cancel)\b.*)\s*$/i);
    if (!m) continue;
    opts.push({ yes: /^yes\b/i.test(m[2]), selected: !!m[1] });
  }
  const yesIdx = opts.findIndex((o) => o.yes);
  const selIdx = opts.findIndex((o) => o.selected);
  if (yesIdx < 0 || selIdx < 0) return null;
  return yesIdx - selIdx;
}

/** A partial trust dialog cannot fall through to ordinary modal confirmation. */
export function trustPromptPending(pane: string): boolean {
  return hasTrustPromptMarker(pane) && trustPromptMoves(pane) === null;
}

/** Input and delays are injected so this module cannot depend back on its tmux compatibility facade. */
export async function acceptTrustPrompt(
  moves: number,
  win: Pick<WindowOps, "sendKey" | "sleep">,
): Promise<void> {
  const key = moves >= 0 ? "Down" : "Up";
  for (let i = 0; i < Math.abs(moves); i++) {
    await win.sendKey(key);
    await win.sleep(120);
  }
  await win.sleep(150);
  await win.sendKey("Enter");
}
