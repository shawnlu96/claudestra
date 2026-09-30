import { expect, test } from "bun:test";
import { ReceiverDrain } from "../src/lib/receiver-drain.ts";
test("在途投递未完成不确认排空；新消息押住，恢复后投递", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((r) => { finish = r; });
  const got: string[] = [], replies: any[] = [];
  const d = new ReceiverDrain(async (c) => { got.push(c); if (c === "old") await gate; }, () => {});
  d.deliver("old", {});
  d.frame({ type: "migration_drain", token: "t" }, (f) => replies.push(f));
  await Bun.sleep(10); expect(replies).toEqual([]); expect(got).toEqual(["old"]);
  finish(); await Bun.sleep(10);
  expect(replies).toEqual([{ type: "acp_migration_drained", id: "t", ok: true }]);
  d.deliver("new", {}); await Bun.sleep(10); expect(got).toEqual(["old"]);
  d.frame({ type: "migration_resume", token: "old" }, () => {});
  expect(got).toEqual(["old"]);
  d.frame({ type: "migration_resume", token: "t" }, () => {});
  await Bun.sleep(10); expect(got).toEqual(["old", "new"]);
});
test("超时恢复先于排空完成：旧确认作废，不再次挂住接收端", async () => {
  let finish!: () => void; const gate = new Promise<void>((r) => { finish = r; });
  const replies: any[] = [], d = new ReceiverDrain(async () => gate, () => {});
  d.deliver("old", {});
  d.frame({ type: "migration_drain", token: "t" }, (f) => replies.push(f));
  d.frame({ type: "migration_resume", token: "t" }, () => {}); finish(); await Bun.sleep(10);
  expect(replies).toEqual([]);
});
