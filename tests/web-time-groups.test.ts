import { describe, expect, test } from "bun:test";
import { groupSegments, type SegLike } from "../web/features/chat/time-groups";

const at = (sec: number) => new Date(Date.UTC(2026, 8, 27, 6, 0, sec)).toISOString();
const text = (sec: number, progress = false): SegLike => ({ kind: "text", ts: at(sec), progress });
const tools = (...secs: number[]): SegLike => ({ kind: "tools", tools: secs.map((s) => ({ ts: at(s) })) });
const reply = (sec: number, body = "done"): SegLike => ({ kind: "reply", ts: at(sec), text: body });

describe("groupSegments", () => {
  test("first segment opens, bursts within the gap merge, gap opens a new group, reply always opens", () => {
    const segs = [text(0), tools(5, 9), text(30), tools(40), text(150), tools(160), reply(170), text(175)];
    const g = groupSegments(segs, at(0), 120_000);
    expect(g.map((x) => [x.start, x.end, x.lead])).toEqual([
      [0, 4, "narr"],
      [4, 6, "narr"],
      [6, 8, "body"],
    ]);
    expect(g[0].ts).toBe(at(0));
    expect(g[1].ts).toBe(at(150));
  });

  test("segments without time never open a group; first group falls back to the message time", () => {
    const segs: SegLike[] = [{ kind: "text" }, { kind: "tools", tools: [{}] }, text(500)];
    const g = groupSegments(segs, at(1), 120_000);
    expect(g.map((x) => [x.start, x.end])).toEqual([
      [0, 2],
      [2, 3],
    ]);
    expect(g[0].ts).toBe(at(1));
  });

  test("progress notes and tool bursts pick their own lead kind; empty reply does not open a group", () => {
    const g = groupSegments([text(0, true), reply(1, "  "), tools(200)], at(0), 120_000);
    expect(g.map((x) => x.lead)).toEqual(["note", "tool"]);
    expect(g[0].end).toBe(2);
  });

  test("empty input", () => {
    expect(groupSegments([], at(0))).toEqual([]);
  });
});
