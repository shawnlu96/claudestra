/** ledger 命令的身份推导、参数解析、保留名（src/manager/ledger-identity.ts、core.assertValidNewName、doctor-state 报警）、写命令判定 */
import { describe, expect, test } from "bun:test";
import { reservedAgentNameChecks } from "../src/lib/doctor-state.js";
import { isReservedAgentName } from "../src/lib/registry.js";
import { assertValidNewName } from "../src/manager/core.js";
import { agentKey, intFlag, jsonObjectFlag, parseLedgerArgs, resolveActor, type ParsedArgs } from "../src/manager/ledger-identity.js";
import { isWriteInvocation, needsWriteLock } from "../src/manager/write-commands.js";

const agents = { "agent-claudestra": { channelId: "111" }, "agent-task-t8b": { channelId: "222" }, "agent-master": { channelId: "999" } };

describe("resolveActor", () => {
  test("没有 DISCORD_CHANNEL_ID（或为空白）→ owner", () => {
    expect(resolveActor({ controlChannelId: "999" }, agents)).toEqual({ ok: true, actor: "owner" });
    expect(resolveActor({ channelId: "  ", controlChannelId: "999" }, agents)).toEqual({ ok: true, actor: "owner" });
  });
  test("控制频道 → master，先于 registry 反查（大总管条目 agent-master 登记着同一频道也不会被认成 agent-master）", () => {
    expect(resolveActor({ channelId: "999", controlChannelId: "999" }, agents)).toEqual({ ok: true, actor: "master" });
  });
  test("agent 频道 → registry 键", () => {
    expect(resolveActor({ channelId: "222", controlChannelId: "999" }, agents)).toEqual({ ok: true, actor: "agent-task-t8b" });
  });
  test("未知频道拒绝，不降级成 owner；没配控制频道时控制频道也算未知", () => {
    const r = resolveActor({ channelId: "333", controlChannelId: "999" }, agents);
    expect(r.ok).toBe(false);
    expect(resolveActor({ channelId: "444" }, {})).toMatchObject({ ok: false });
  });
});

describe("参数解析", () => {
  test("--k v / --k=v / 开关 / -- 之后全是正文", () => {
    const p = parseLedgerArgs(["note", "T1", "--project=p", "--dedup", "k1", "--transcribed", "--", "--不是旗标"], ["project", "dedup"], ["transcribed"]) as ParsedArgs;
    expect(p.pos).toEqual(["note", "T1", "--不是旗标"]);
    expect(p.flags).toEqual({ project: "p", dedup: "k1" });
    expect([...p.bools]).toEqual(["transcribed"]);
  });
  test("不认识的旗标、缺值报错（拼错的旗标不会悄悄变成正文）", () => {
    expect(parseLedgerArgs(["note", "--form", "x"], ["project"])).toEqual({ error: "不认识的参数 --form" });
    expect(parseLedgerArgs(["stage", "--from"], ["from"])).toEqual({ error: "--from 缺少值" });
  });
  test("intFlag / jsonObjectFlag 校验", () => {
    const p = { pos: [], flags: { rev: "3", bad: "-1", extra: '{"a":1}', arr: "[1]", junk: "{" }, bools: new Set<string>() };
    expect(intFlag(p, "rev")).toBe(3);
    expect(intFlag(p, "none")).toBeUndefined();
    expect(() => intFlag(p, "bad")).toThrow("非负整数");
    expect(jsonObjectFlag(p, "extra")).toEqual({ a: 1 });
    expect(() => jsonObjectFlag(p, "arr")).toThrow("JSON 对象");
    expect(() => jsonObjectFlag(p, "junk")).toThrow("不是合法 JSON");
  });
  test("agentKey：补 agent- 前缀、小写；master / owner 原样", () => {
    expect(agentKey("Task-T8b")).toBe("agent-task-t8b");
    expect(agentKey("agent-claudestra")).toBe("agent-claudestra");
    expect(agentKey("master")).toBe("master");
  });
});

describe("保留名 owner / master", () => {
  test("isReservedAgentName 认裸名与 agent- 前缀、不分大小写", () => {
    for (const n of ["owner", "Owner", "agent-owner", "master", "agent-MASTER"]) expect(isReservedAgentName(n)).toBe(true);
    for (const n of ["owners", "agent-task-owner", "masterful"]) expect(isReservedAgentName(n)).toBe(false);
  });
  test("新建 / resume / 改名共用的 assertValidNewName 拒绝保留名", () => {
    expect(() => assertValidNewName("owner")).toThrow("保留名");
    expect(() => assertValidNewName("agent-master")).toThrow("保留名");
    expect(() => assertValidNewName("task-t8b")).not.toThrow();
  });
  test("名字字符黑名单与台账负责人校验共用（lib/registry.ts）：@ 与 CJK 允许，零宽 / 方向控制等不可见字符拒绝", () => {
    expect(() => assertValidNewName("a@b")).not.toThrow();
    expect(() => assertValidNewName("数据")).not.toThrow();
    const cases: [string, string][] = [
      ["a\u200bb", "U+200B"], ["a\u202eb", "U+202E"], ["a\u2060b", "U+2060"], ["a\u200db", "U+200D"],
      // 不在 \p{Cf} 里的：变体选择符（Mn）、韩文填充符（Lo）、CGJ、高棉文不发音元音、盲文空格
      ["dev\u2764\ufe0f", "U+FE0F"], ["a\u3164b", "U+3164"], ["a\u115fb", "U+115F"], ["a\u034fb", "U+034F"], ["a\u17b4b", "U+17B4"], ["a\u2800b", "U+2800"],
    ];
    for (const [bad, code] of cases) {
      expect(() => assertValidNewName(bad)).toThrow("名字不能含不可见字符（零宽连接符等）");
      expect(() => assertValidNewName(bad)).toThrow(`这里有 ${code}，请换一个名字`);
    }
    expect(() => assertValidNewName("dev\u2764\ufe0f")).toThrow("变体选择符 U+FE0F，去掉再试");
    expect(() => assertValidNewName("dev\u2764")).not.toThrow();
  });
  test("doctor：已有 agent-owner 报 warn；agent-master 是大总管自己的条目不算", () => {
    expect(reservedAgentNameChecks(["agent-claudestra", "agent-master"])).toEqual([]);
    expect(reservedAgentNameChecks(["agent-owner", "agent-x"])).toMatchObject([{ status: "warn", name: "保留名" }]);
  });
});

describe("写命令判定（认主守卫 + 命令级写锁）", () => {
  test("ledger 的读子命令放行，其余全算写", () => {
    for (const sub of ["", "help", "whoami", "show", "export"]) expect(isWriteInvocation("ledger", [sub].filter(Boolean))).toBe(false);
    for (const sub of ["item-new", "task-new", "task-set", "stage", "note", "deliver", "review", "decision", "deploy", "verify", "rollback", "freeze", "unfreeze", "import"]) {
      expect(isWriteInvocation("ledger", [sub])).toBe(true);
    }
  });
  test("meta：不带 --pms / --docs-dir 是查看（算读，备机不挡）；带了才算写", () => {
    expect(isWriteInvocation("ledger", ["meta"])).toBe(false);
    expect(isWriteInvocation("ledger", ["meta", "--project", "p"])).toBe(false);
    expect(isWriteInvocation("ledger", ["meta", "--pms", "a"])).toBe(true);
    expect(isWriteInvocation("ledger", ["meta", "--project=p", "--docs-dir=~/d"])).toBe(true);
  });
});

describe("命令级写锁（只给会写 registry 的 ledger 子命令）", () => {
  test("task-new / task-set / import 拿锁；其余 ledger 写只过认主守卫不拿锁；别的命令照旧", () => {
    for (const sub of ["task-new", "task-set", "import"]) expect(needsWriteLock("ledger", [sub])).toBe(true);
    for (const sub of ["stage", "note", "deliver", "review", "meta", "show"]) expect(needsWriteLock("ledger", [sub])).toBe(false);
    expect(isWriteInvocation("ledger", ["stage"])).toBe(true);
    expect(needsWriteLock("create", [])).toBe(true);
    expect(needsWriteLock("list", [])).toBe(false);
  });
});
