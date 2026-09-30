/**
 * Circumstantial evidence about who ran a ledger write: the tmux window, the parent process chain and the cwd. None of
 * it is proof — every local agent is an unrestricted shell as the same user and can fake all of it — so it is recorded
 * next to an auto card's verdict and compared, never used to refuse. It catches the mistakes the identity checks exist
 * for (an author's shell writing the reviewer's verdict, a verdict run from the wrong checkout), and makes a deliberate
 * forgery visible in the audit instead of silent.
 */
import { realpathSync } from "node:fs";
import { basename, sep } from "node:path";
import type { AuthorFamily } from "./ledger-scheduler.js";
import { tmuxRaw } from "./tmux-helper.js";

export interface CallerWitness {
  cwd: string;
  /** Window name of $TMUX_PANE on the orchestrator's tmux server; null = not in a tmux pane (ACP-hosted runtimes). */
  tmuxWindow: string | null;
  /** Executable names up the parent chain, nearest first. */
  procs: string[];
}

const MAX_DEPTH = 12;

function parentChain(start: number): string[] {
  const out: string[] = [];
  for (let pid = start, i = 0; pid > 1 && i < MAX_DEPTH; i++) {
    const r = Bun.spawnSync(["ps", "-o", "ppid=,args=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
    const m = /^\s*(\d+)\s+(\S+)/.exec(r.stdout.toString());
    if (r.exitCode !== 0 || !m) break;
    out.push(basename(m[2]).slice(0, 60));
    pid = Number(m[1]);
  }
  return out;
}

/** Starts at the parent: this process is always `bun manager.ts`, whose own path would match any family. */
export async function collectCallerWitness(): Promise<CallerWitness> {
  const pane = process.env.TMUX_PANE;
  const tmuxWindow = pane ? (await tmuxRaw(["display-message", "-p", "-t", pane, "#W"], { timeoutMs: 2000 })).trim() || null : null;
  return { cwd: process.cwd(), tmuxWindow, procs: parentChain(process.ppid) };
}

const real = (p: string): string => { try { return realpathSync(p); } catch { return p; /* a vanished path compares as written; a mismatch is the useful answer */ } };
const inside = (child: string, dir: string): boolean => { const c = real(child), d = real(dir); return c === d || c.startsWith(d + sep); };
const FAMILY_PROC: Record<AuthorFamily, RegExp> = { claude: /^claude\b/i, codex: /^codex/i };

/** Each entry is one fact that does not fit the claimed reviewer; empty = consistent (not proven). */
export function witnessMismatch(w: CallerWitness, claim: { agent: string; family: AuthorFamily; dir?: string }): string[] {
  const out: string[] = [];
  if (w.tmuxWindow && w.tmuxWindow !== claim.agent) out.push(`tmux 窗口是 ${w.tmuxWindow}，不是 ${claim.agent}`);
  if (claim.dir && !inside(w.cwd, claim.dir)) out.push(`cwd 在 ${w.cwd}，不在审查目录 ${claim.dir}`);
  if (!w.procs.some((p) => FAMILY_PROC[claim.family].test(p))) out.push(`父进程链里没有 ${claim.family}（${w.procs.slice(0, 6).join(" ← ") || "空"}）`);
  return out;
}
