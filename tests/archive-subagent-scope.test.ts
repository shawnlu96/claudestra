/**
 * 归档里子 agent 文件的真实路径要在本 agent 自己的归档目录下（T32 adv4 P2-2）：以前核的是整个归档根，
 * agent-x/<sid>/ 做成链接指到 agent-other 的会话目录，?subagent= 就能读到别的 agent 的子 agent 记录。走真实鉴权（tests/api-runner-harness.ts）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { runnerHome, type RunnerHome, type RunnerResult } from "./api-runner-harness";
import { guestGrant, hashDeviceToken, type DeviceCredential } from "../src/lib/devices";

const at = "2026-01-01T00:00:00Z";
const SID_OWN = "11111111-2222-3333-4444-555555555555";
const SID_LINK = "22222222-3333-4444-5555-666666666666";
const SID_OTHER = "33333333-4444-5555-6666-777777777777";
const device: DeviceCredential = {
  id: "dev_guest", v: 1, type: "bearer", hash: hashDeviceToken("dev_guest"), deviceName: "g", grant: guestGrant(["*"]), createdAt: at, expiresAt: "2099-01-01T00:00:00Z",
};
const PRINCIPALS = [{ id: "guest:all", role: "external", name: "friend", agents: ["*"], createdAt: at, credentials: [device] }];
const line = (text: string) => JSON.stringify({ type: "user", uuid: "u1", timestamp: at, message: { role: "user", content: text } }) + "\n";

let sandbox: RunnerHome | null = null;
let results: RunnerResult[] = [];

beforeAll(() => {
  sandbox = runnerHome("archive-subagent-", { agents: {} });
  const archive = join(sandbox.home, ".claude-orchestrator", "archive");
  const own = join(archive, "agent-x");
  const other = join(archive, "agent-other");
  mkdirSync(join(own, SID_OWN, "subagents"), { recursive: true });
  mkdirSync(join(other, SID_OTHER, "subagents"), { recursive: true });
  for (const sid of [SID_OWN, SID_LINK]) writeFileSync(join(own, `${sid}.jsonl`), line("x 的会话"));
  writeFileSync(join(other, `${SID_OTHER}.jsonl`), line("other 的会话"));
  writeFileSync(join(own, SID_OWN, "subagents", "agent-a.jsonl"), line("x 自己的子 agent"));
  writeFileSync(join(other, SID_OTHER, "subagents", "agent-a.jsonl"), line("OTHER-SECRET"));
  symlinkSync(join(other, SID_OTHER), join(own, SID_LINK)); // x 的会话目录指到 other 的
  const get = (name: string, sid: string) => ({ name, method: "GET", path: `/api/v1/agents/x/history/${sid}?subagent=agent-a`, auth: { device: "dev_guest" } });
  results = sandbox.run([get("own", SID_OWN), get("link", SID_LINK)], { RUNNER_PRINCIPALS: JSON.stringify(PRINCIPALS) });
}, 60_000);

afterAll(() => sandbox?.cleanup());

describe("归档子 agent：只读本 agent 目录下的", () => {
  test("自己的子 agent 记录照常 200", () => {
    const r = results.find((x) => x.name === "own")!;
    expect([r.status, String(r.body).includes("x 自己的子 agent")]).toEqual([200, true]);
  });
  test("会话目录链接到别的 agent → 404，读不到对方内容", () => {
    const r = results.find((x) => x.name === "link")!;
    expect([r.status, String(r.body).includes("OTHER-SECRET")]).toEqual([404, false]);
  });
});
