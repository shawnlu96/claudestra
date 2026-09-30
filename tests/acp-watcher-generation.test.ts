import { expect, test } from "bun:test";
import { installAcpPushWatcher } from "../src/bridge/acp-watcher-generation";

test("clear rebind wins over a stale registration lookup; later legitimate session changes still work", async () => {
  const ch = "local-watcher-race";
  const installed: string[] = [];
  const install = (sid: string) => () => installed.push(sid);
  expect(await installAcpPushWatcher(ch, "old", false, install("old"))).toBe(true);
  expect(await installAcpPushWatcher(ch, "new", true, install("new"))).toBe(true);
  expect(await installAcpPushWatcher(ch, "old", false, install("stale"), async () => "new")).toBe(false);
  expect(installed).toEqual(["old", "new"]);
  expect(await installAcpPushWatcher(ch, "later", false, install("later"), async () => "later")).toBe(true);
  expect(installed).toEqual(["old", "new", "later"]);
});

test("rebind during a pending registry read makes its old answer stale", async () => {
  const ch = "local-watcher-race-read";
  const installed: string[] = [];
  await installAcpPushWatcher(ch, "first", true, () => installed.push("first"));
  let finish!: (sid: string) => void;
  const read = new Promise<string>((resolve) => { finish = resolve; });
  const stale = installAcpPushWatcher(ch, "older", false, () => installed.push("older"), () => read);
  await installAcpPushWatcher(ch, "newest", true, () => installed.push("newest"));
  finish("older");
  expect(await stale).toBe(false);
  expect(installed).toEqual(["first", "newest"]);
});
