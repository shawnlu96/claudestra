/**
 * TMUXPIN1: one plain tmuxSendLine addresses one pane. The real tmuxSendLine runs in a child with a private HOME / state /
 * runtime against a fake tmux that models two windows and logs both every argv and which pane a key really reached.
 */
import { testChildEnv } from "./test-env.js";
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { TmuxCommandError } from "../src/lib/tmux-failure.js";
import { pinSendTarget, pinStillThere, SendTargetLost } from "../src/lib/tmux-send-target.js";

const NAME = "master:=agent-x";

/**
 * After the literal lands: `takeover` moves the name to window @2 (pane %2) while %1 lives on, `vanish` also kills %1,
 * `unbind` kills %1 and leaves the name with nobody. Before anything: `missing` has no such window, `ambiguous` has two
 * (tmux answers both with an error), `split` shows the window with a second, inactive pane.
 * Inside window @1, after the literal: `switch` makes its other pane %4 the active one while %1 lives on, `paneGone` kills
 * %1 and leaves the window to %4.
 */
type Mode = "stable" | "takeover" | "vanish" | "unbind" | "missing" | "ambiguous" | "split" | "switch" | "paneGone";

/**
 * Fake tmux. `owner` holds the window number the name is bound to (empty = none); `gone1` exists once pane %1 is dead;
 * `active1` holds the active pane of window @1, the pane a window target (name or @1) reaches at that moment.
 */
function fakeTmux(dir: string, mode: Mode): string {
  const afterLiteral = mode === "takeover" ? "printf 2 > \"$d/owner\"" : mode === "vanish" ? "printf 2 > \"$d/owner\"; : > \"$d/gone1\""
    : mode === "unbind" ? ": > \"$d/owner\"; : > \"$d/gone1\"" : mode === "switch" ? "printf 4 > \"$d/active1\""
    : mode === "paneGone" ? "printf 4 > \"$d/active1\"; : > \"$d/gone1\"" : ":";
  return `#!/bin/sh
d='${dir}'
shift 4
for a in "$@"; do printf '%s\\037' "$a" >> "$d/argv"; done; printf '\\n' >> "$d/argv"
cmd=$1; t=; fmt=; prev=
for a in "$@"; do
  [ "$prev" = -t ] && t=$a
  [ "$prev" = -F ] && fmt=$a
  prev=$a
done
case "$t" in
  '${NAME}') n=$(cat "$d/owner") ;;
  @1) n=1 ;;
  %1) n=p1 ;;
  %2|@2) n=2 ;;
  %4) n=4 ;;
  *) n= ;;
esac
[ "$n" = 1 ] && n=$(cat "$d/active1")
[ "$n" = p1 ] && n=1
w=$n; [ "$n" = 4 ] && w=1
[ "$n" = 1 ] && [ -f "$d/gone1" ] && n=
[ "$n" = 2 ] && [ "$(cat "$d/owner")" != 2 ] && n=
if [ -z "$n" ]; then printf "can't find target: %s\\n" "$t" >&2; exit 1; fi
case "$cmd" in
  send-keys)
    case "$*" in
      *' -l '*) printf '%%%s literal\\n' "$n" >> "$d/delivered"; ${afterLiteral} ;;
      *' Enter') printf '%%%s Enter\\n' "$n" >> "$d/delivered" ;;
    esac ;;
  list-panes)
    case "$fmt" in
      *pane_active*) ${mode === "split" ? "printf '0\\t%%3\\n'; " : ""}printf '1\\t%%%s\\n' "$n" ;;
      *pane_id*) printf '%%%s\\n' "$n" ;;
      *window_id*) printf '@%s\\n' "$w" ;;
      *pane_in_mode*) printf '0\\n' ;;
    esac ;;
  capture-pane) printf 'host repo %% \\n' ;;
esac
`;
}

async function sendLine(mode: Mode, strict: boolean, target = NAME) {
  const dir = mkdtempSync(join(tmpdir(), "audit-target-"));
  const bin = join(dir, "bin"), state = join(dir, "state"), runtime = join(dir, "run");
  for (const path of [bin, state, runtime]) mkdirSync(path);
  for (const file of ["argv", "delivered"]) writeFileSync(join(dir, file), "");
  writeFileSync(join(dir, "owner"), mode === "missing" || mode === "ambiguous" ? "" : "1");
  writeFileSync(join(dir, "active1"), "1");
  writeFileSync(join(bin, "tmux"), fakeTmux(dir, mode));
  chmodSync(join(bin, "tmux"), 0o755);
  const script = `const { tmuxSendLine } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/lib/tmux-helper.ts"))});
try { await tmuxSendLine(${JSON.stringify(target)}, "run it", 0, ${strict}); console.log("sent"); }
catch (e) { console.log("threw " + e.name + ": " + e.message); }`;
  try {
    const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
      env: testChildEnv({ HOME: dir, TMPDIR: dir, PATH: `${bin}:/usr/bin:/bin`, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: runtime }),
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const lines = (file: string) => readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean);
    const argv = lines("argv").map((line) => line.split("\x1f").slice(0, -1));
    return { out: out.trim(), err, argv, keys: argv.filter((a) => a[0] === "send-keys"), delivered: lines("delivered"), inputs: readdirSync(runtime).filter((f) => f.endsWith(".input")) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const LITERAL = ["send-keys", "-t", "%1", "-l", "--", "run it"], ENTER = ["send-keys", "-t", "%1", "Enter"];

test("[验收线 1] the pane does not change: literal and Enter reach it once each, both by its pane ID", async () => {
  for (const strict of [false, true]) {
    const r = await sendLine("stable", strict);
    expect(r.out).toBe("sent");
    expect(r.keys).toEqual([LITERAL, ENTER]);
    expect(r.delivered).toEqual(["%1 literal", "%1 Enter"]);
    expect(r.inputs).toEqual(["esc-_1.input"]);
  }
}, 40_000);

test("[验收线 1] another window takes the name after the literal: the Enter stays with the original pane", async () => {
  for (const strict of [false, true]) {
    const r = await sendLine("takeover", strict);
    expect(r.out).toBe("sent");
    expect(r.delivered).toEqual(["%1 literal", "%1 Enter"]);
    expect(r.keys).toEqual([LITERAL, ENTER]);
    expect(r.inputs).toEqual(["esc-_1.input"]); // the record stays under the window that got the text
  }
}, 40_000);

test("[验收线 1] the original pane is gone before the Enter: zero Enter, whoever holds the name now", async () => {
  for (const mode of ["vanish", "unbind"] as const) {
    const loose = await sendLine(mode, false);
    expect(loose.out).toBe("sent"); // the non-launch paths keep swallowing; the stop is logged
    expect(loose.err).toContain("的 pane %1 在回车前消失");
    expect(loose.keys).toEqual([LITERAL]);
    expect(loose.delivered).toEqual(["%1 literal"]);
    const launch = await sendLine(mode, true);
    expect(launch.out).toStartWith("threw SendTargetLost: ");
    expect(launch.keys).toEqual([LITERAL]);
    expect(launch.delivered).toEqual(["%1 literal"]);
  }
}, 60_000);

test("[验收线 1] a target that resolves to no single pane sends nothing and records no input", async () => {
  for (const mode of ["missing", "ambiguous"] as const) {
    const loose = await sendLine(mode, false);
    expect(loose.out).toBe("sent");
    expect(loose.err).toContain("不存在或不唯一");
    const launch = await sendLine(mode, true);
    expect(launch.out).toStartWith("threw SendTargetLost: ");
    for (const r of [loose, launch]) {
      expect(r.argv.map((a) => a[0])).toEqual(["list-panes"]); // one lookup, no second try under another spelling
      expect(r.delivered).toEqual([]);
      expect(r.inputs).toEqual([]);
    }
  }
}, 60_000);

test("a window with a second pane pins its active pane; a caller's pane ID is used as given", async () => {
  const split = await sendLine("split", true);
  expect(split.keys).toEqual([LITERAL, ENTER]);
  const fixed = await sendLine("takeover", true, "%1");
  expect(fixed.out).toBe("sent");
  expect(fixed.keys).toEqual([LITERAL, ENTER]);
  expect(fixed.delivered).toEqual(["%1 literal", "%1 Enter"]);
  expect(fixed.argv.some((a) => a.includes("#{pane_active}\t#{pane_id}"))).toBe(false);
}, 40_000);

test("[验收线 1] a window ID is not a pane: the window's active pane changes after the literal, the Enter stays with the first", async () => {
  for (const target of ["@1", NAME]) {
    for (const strict of [false, true]) {
      const r = await sendLine("switch", strict, target);
      expect(r.out).toBe("sent");
      expect(r.keys).toEqual([LITERAL, ENTER]); // never `-t @1`: that is whichever pane is active at each key
      expect(r.delivered).toEqual(["%1 literal", "%1 Enter"]);
      expect(r.inputs).toEqual(["esc-_1.input"]);
    }
  }
}, 60_000);

test("[验收线 1] a window ID whose first pane dies while the window lives on with another pane: zero Enter", async () => {
  for (const target of ["@1", NAME]) {
    const loose = await sendLine("paneGone", false, target);
    expect(loose.out).toBe("sent");
    expect(loose.err).toContain("的 pane %1 在回车前消失");
    const launch = await sendLine("paneGone", true, target);
    expect(launch.out).toStartWith("threw SendTargetLost: ");
    for (const r of [loose, launch]) {
      expect(r.keys).toEqual([LITERAL]);
      expect(r.delivered).toEqual(["%1 literal"]); // %4 holds the window now and gets nothing
    }
  }
}, 60_000);

test("pinSendTarget: exactly one active pane or nothing; only a tmux failure counts as a missing target", async () => {
  const answer = (out: string) => async () => out;
  expect(await pinSendTarget(NAME, answer("1\t%4"), true)).toBe("%4");
  expect(await pinSendTarget(NAME, answer("0\t%3\n1\t%4"), true)).toBe("%4");
  for (const out of ["", "0\t%3", "1\t%3\n1\t%4", "1\t@4", "%4"]) {
    await expect(pinSendTarget(NAME, answer(out), true)).rejects.toBeInstanceOf(SendTargetLost);
    expect(await pinSendTarget(NAME, answer(out), false)).toBeNull();
  }
  expect(await pinSendTarget("%7", async () => { throw new Error("not asked"); }, true)).toBe("%7");
  expect(await pinSendTarget("@7", answer("0\t%3\n1\t%4"), true)).toBe("%4"); // a window ID still has to name its pane
  const gone = async () => { throw new TmuxCommandError(["list-panes"], 1, "can't find window"); };
  await expect(pinSendTarget(NAME, gone, true)).rejects.toBeInstanceOf(SendTargetLost);
  expect(await pinSendTarget(NAME, gone, false)).toBeNull();
  const lease = new Error("SchedulerLeaseLost");
  await expect(pinSendTarget(NAME, async () => { throw lease; }, false)).rejects.toBe(lease);
  await expect(pinStillThere(NAME, "%4", async () => { throw lease; }, false)).rejects.toBe(lease);
  expect(await pinStillThere(NAME, "%4", answer("%3\n%4"), true)).toBe(true);
  expect(await pinStillThere(NAME, "%4", answer("%3"), false)).toBeNull();
  await expect(pinStillThere(NAME, "%4", gone, true)).rejects.toBeInstanceOf(SendTargetLost);
  expect(await pinStillThere("%7", "%7", gone, true)).toBe(true); // a caller's pane ID: tmux itself refuses the key
  await expect(pinStillThere("@7", "%4", gone, true)).rejects.toBeInstanceOf(SendTargetLost);
});
