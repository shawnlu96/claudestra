/** Generated shard shapes preserve real counts and byte sizes without committing megabytes of logs. */
import { GATE } from "../src/lib/scheduler-merge-ci-rerun-log.js";
export interface FixtureJob { id: number; name: string; failedSteps: string[]; log: string }
const stamp = "2026-10-13T20:00:00.1234567Z ";
function sized(job: string, step: string, body: string[], bytes: number): string {
  const lines = body.map((s) => `${job}\t${step}\t${stamp}${s}`);
  let room = bytes - Buffer.byteLength(lines.join("\n"));
  if (room < 0) throw new Error("fixture too small");
  const pads = lines.map((l, i) => l.includes("(pass) ") || /Z\s*$/.test(l) ? i : -1).filter((i) => i >= 0);
  if (!pads.length) throw new Error("fixture needs padding lines");
  for (let i = 0; i < pads.length; i++) {
    const n = Math.ceil(room / (pads.length - i));
    lines[pads[i]!] += " ".repeat(n);
    room -= n;
  }
  return lines.join("\n");
}
function shard(name: string, bytes: number, file: string, failures: number, timeout: boolean, unknown = false,
  groups = 230, passes = 3100, noisyPass = false): string {
  const body: string[] = ["Run bun test", "bun test v1.3.14"];
  for (let i = 0; i < groups; i++) {
    body.push(`##[group]${i === groups - 1 ? file : `tests/anonymous-${i}.test.ts`}:`);
    if (i === 3 && noisyPass) body.push("error: expected console output");
    const n = Math.floor(passes / groups) + (i < passes % groups ? 1 : 0);
    for (let j = 0; j < n; j++) body.push(`(pass) anonymous case ${i}-${j} [1.00ms]`);
    if (i === groups - 1) for (let k = 0; k < failures; k++) {
      if (!timeout) body.push("error: expect(received).toBe(expected)", "##[error]assertion failed");
      body.push(`(fail) anonymous failure ${k} [5000.12ms]`);
      if (timeout) body.push("  ^ this test timed out after 5000ms.");
    }
    body.push("##[endgroup]");
  }
  for (let k = 0; k < failures; k++) body.push(`(fail) anonymous failure ${k} [5000.12ms]`);
  body.push(` ${passes} pass`, ` ${failures} fail`, "##[error]Process completed with exit code 1.");
  return sized(name, unknown ? "UNKNOWN STEP" : "Unit tests", body, bytes);
}
function gate(bytes: number, unknown = false): FixtureJob {
  return { id: 9, name: GATE.job, failedSteps: [GATE.step], log: sized(GATE.job, unknown ? "UNKNOWN STEP" : GATE.step,
    ["", "##[error]分片没有全部成功：failure", "##[error]Process completed with exit code 1."], bytes) };
}
export function ciLogFixture(kind: "A" | "B" | "C", file = "tests/anonymous-failure.test.ts"): FixtureJob[] {
  if (kind === "A") return [{ id: 7, name: "shard 7", failedSteps: ["Unit tests"],
    log: shard("shard 7", 934869, file, 2, false, true, 219, 3028) }, gate(4553, true)];
  if (kind === "C") return [{ id: 7, name: "shard 7", failedSteps: ["Unit tests"],
    log: shard("shard 7", 1205458, file, 1, true) }, gate(791)];
  return [
    { id: 3, name: "shard 3", failedSteps: ["Unit tests"], log: shard("shard 3", 909600, file, 1, false, false, 230, 3100, true) },
    { id: 6, name: "shard 6", failedSteps: ["Unit tests"], log: shard("shard 6", 731087, "tests/anonymous-other.test.ts", 1, false) },
    { id: 1, name: "shard 1", failedSteps: ["Guard (ratchets)"], log: sized("shard 1", "Guard (ratchets)",
      ["", 'error: script "guard" exited with code 1', "##[error]Process completed with exit code 1."], 1551) }, gate(791),
  ];
}
export const wholeLog = (jobs: readonly FixtureJob[]): string => jobs.map((j) => j.log).join("\n");
