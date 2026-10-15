import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerSelectedRepair, enqueueSelectedRepair } from "../src/bridge/scheduler-ci-selected-notice.js";
import { PmDigestStore, PM_DIGEST_LOG_MS } from "../src/lib/pm-digest-store.js";
import { digestText } from "../src/lib/pm-digest.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function store() {
  const dir = mkdtempSync(join(tmpdir(), "cisel2-intake-"));
  dirs.push(dir);
  return new PmDigestStore(join(dir, "digest.json"), join(dir, "modes.json"));
}
const msg = { requestId: "r1", project: "p", key: "a".repeat(16), runUrl: "https://github.com/org/failover/actions/runs/11" };

test("intake queues a non-urgent repair regardless of text and modes; full long URL survives rendering", () => {
  const s = store(), runUrl = `https://github.com/org/${"a".repeat(100)}/actions/runs/11`;
  s.setMode("p", "off");
  s.setRouteMode("p", "off");
  enqueueSelectedRepair({ ...msg, runUrl }, s, 100);
  expect(s.queued("p")).toHaveLength(1);
  expect(digestText(s.queued("p"))).toContain(runUrl);
  expect(s.read().log[0]!.send).toBe("digest");
});

test("lost acknowledgement, consumption, and repeated bridge restarts retain the 24-hour key receipt", () => {
  const s = store();
  answerSelectedRepair({ send: () => { throw new Error("socket closed after persistence"); } }, msg, s);
  const at = s.read().log[0]!.at;
  expect(s.queued("p")).toHaveLength(1);
  s.remove(new Set(s.queued("p").map((e) => e.id)), at);
  for (let i = 0; i < 3; i++) {
    const fresh = new PmDigestStore(s.path, s.modePath);
    enqueueSelectedRepair(msg, fresh, at + 1);
    expect(fresh.queued("p")).toEqual([]);
  }
  enqueueSelectedRepair(msg, s, at + PM_DIGEST_LOG_MS);
  expect(s.queued("p")).toHaveLength(1);
  enqueueSelectedRepair({ ...msg, project: "other" }, s, at + PM_DIGEST_LOG_MS);
  expect(s.queued("other")).toHaveLength(1);
});

test("failed persistent intake returns error and recovers after restart without losing or duplicating a repair", () => {
  const s = store(), answers: string[] = [];
  writeFileSync(s.path, "broken JSON");
  answerSelectedRepair({ send: (v) => answers.push(v) }, msg, s);
  expect(JSON.parse(answers[0]!)).toMatchObject({ requestId: "r1", error: expect.any(String) });
  expect(readFileSync(s.path, "utf8")).toBe("broken JSON");
  writeFileSync(s.path, JSON.stringify({ queue: [], log: [] }));
  const fresh = new PmDigestStore(s.path, s.modePath);
  answerSelectedRepair({ send: (v) => answers.push(v) }, msg, fresh);
  expect(JSON.parse(answers[1]!)).toMatchObject({ result: { queued: true } });
  answerSelectedRepair({ send: (v) => answers.push(v) }, msg, new PmDigestStore(s.path, s.modePath));
  expect(fresh.queued("p")).toHaveLength(1);
});

test("malformed structured fields cannot enqueue arbitrary text or links", () => {
  const s = store();
  for (const bad of [{ key: "failed?" }, { runUrl: "https://example.com/" }, { project: "" }]) {
    expect(() => enqueueSelectedRepair({ ...msg, ...bad }, s)).toThrow("invalid CI repair notice");
  }
  expect(s.queued("p")).toEqual([]);
});
