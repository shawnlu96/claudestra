// codex app-server 协议的漂移门：protocol.ts ↔ 锁文件（tests/fixtures/codex-app-server/）离线对照，加上分级器的合成变异。
// 设了 CODEX_SCHEMA_CLI 才跑最后一组：用那个 codex 重新生成锁并分级（只跑离线子命令，CODEX_HOME 是临时空目录）。
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { USED } from "../src/lib/acp/codex-adapter/protocol.ts";
import { classify, type LockSet } from "../scripts/codex-schema/drift.ts";
import { buildOutbound, generateLockSet, lockProblems, overlayInbound, readLockSet } from "../scripts/codex-schema/lock.ts";
import { compat, type Defs, type PNode, project } from "../scripts/codex-schema/project.ts";

const LOCK = readLockSet();
const OUT_ROOTS: [string, z.ZodType][] = [
  ...Object.values(USED.client).map((e): [string, z.ZodType] => [e.params.def, e.params.schema]),
  ...Object.values(USED.server).map((e): [string, z.ZodType] => [e.result.def, e.result.schema]),
];

/** 把锁里的出站闭包转成 zod 能吃的自包含 schema（$defs + 扁平名字），按 codex 的定义校验我们构造的对象 */
function closureSchema(defs: Defs, root: string): z.ZodType {
  const flat = (n: string) => n.replace(/\//g, "__");
  const fix = (v: unknown) => JSON.parse(JSON.stringify(v).replace(/"#\/definitions\/([^"]+)"/g, (_m, n: string) => `"#/$defs/${flat(n)}"`));
  const $defs = Object.fromEntries(Object.entries(defs).map(([k, v]) => [flat(k), fix(v)]));
  return z.fromJSONSchema({ $defs, $ref: `#/$defs/${flat(root)}` } as never) as z.ZodType;
}

const text = [{ type: "text", text: "hi", text_elements: [] }];
const turnStart = { threadId: "th", input: text, approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" }, summary: "auto", effort: null, model: "m" };
const workspace = { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
const opened = { threadId: "th", cwd: "/w", config: { a: 1 }, excludeTurns: true, modelProvider: "openai" };
/** 每个出站定义至少一个我们会构造的样子；判别联合每个分支都要有 */
const SAMPLES: Record<string, object[]> = {
  "InitializeParams": [{ clientInfo: { name: "c", version: "1", title: "T" }, capabilities: { experimentalApi: true, requestAttestation: false } }],
  "v2/GetAccountParams": [{ refreshToken: false }],
  "v2/ConfigReadParams": [{ includeLayers: false }],
  "v2/ModelListParams": [{ cursor: null, limit: null }, { cursor: "next", limit: null }],
  "v2/ThreadStartParams": [{ config: {}, modelProvider: null, cwd: "/w" }],
  "v2/ThreadResumeParams": [opened],
  "v2/ThreadForkParams": [opened],
  "v2/ThreadUnsubscribeParams": [{ threadId: "th" }],
  "v2/ThreadReadParams": [{ threadId: "th" }],
  "v2/ThreadCompactStartParams": [{ threadId: "th" }],
  "v2/TurnStartParams": [
    turnStart,
    { ...turnStart, approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false }, effort: "high", summary: "none" },
    { ...turnStart, approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxPolicy: workspace },
  ],
  "v2/TurnSteerParams": [{ threadId: "th", input: text, expectedTurnId: "T1" }],
  "v2/TurnInterruptParams": [{ threadId: "th", turnId: "T1" }],
  "CommandExecutionRequestApprovalResponse": ["accept", "acceptForSession", "decline", "cancel"].map((decision) => ({ decision })),
  "FileChangeRequestApprovalResponse": ["accept", "acceptForSession", "decline", "cancel"].map((decision) => ({ decision })),
  "PermissionsRequestApprovalResponse": [{ permissions: {}, scope: "turn", strictAutoReview: false }],
  "McpServerElicitationRequestResponse": [{ action: "cancel", content: null, _meta: null }],
  "ToolRequestUserInputResponse": [{ answers: {} }],
};

describe("离线对照（锁文件 ↔ protocol.ts）", () => {
  test("锁文件本身兼容：入站、出站投影和 method 表都没问题", () => {
    expect(lockProblems(LOCK)).toEqual([]);
  });

  test("入站：当前 IN 的每条读取路径都在 inbound.json 里，类型、可空、必有、封闭枚举都兼容", () => {
    const fresh = overlayInbound(LOCK.inbound);
    expect(compat(fresh, "in")).toEqual([]);
    for (const [def, nodes] of Object.entries(fresh)) expect([def, ...Object.keys(nodes).sort()]).toEqual([def, ...Object.keys(LOCK.inbound[def] ?? {}).sort()]);
    expect(Object.keys(fresh).sort()).toEqual(Object.keys(LOCK.inbound).sort());
  });

  test("出站：按当前 OUT 在锁里的闭包上重算，闭包和投影都和 outbound.json 逐项相同", () => {
    expect(buildOutbound(LOCK.outbound.defs)).toEqual(LOCK.outbound);
  });

  test("method 表和 USED 一致", () => {
    const rows = (t: Record<string, { params: { def: string }; result?: { def: string } }>) => Object.fromEntries(Object.entries(t).map(([m, e]) => [m, [e.params.def, e.result?.def]]));
    const locked = (t: Record<string, { params: string; result?: string }>) => Object.fromEntries(Object.entries(t).map(([m, r]) => [m, [r.params, r.result]]));
    expect(locked(LOCK.methods.client)).toEqual(rows(USED.client));
    expect(locked(LOCK.methods.server)).toEqual(rows(USED.server));
    expect(locked(LOCK.methods.notifications)).toEqual(rows(USED.notifications));
    expect(Object.keys(LOCK.methods.clientNotifications)).toEqual(USED.clientNotifications);
  });

  test("我们构造的每种出站对象：过 OUT 的严格校验，也过 codex 闭包的 JSON Schema 校验", () => {
    for (const [def, schema] of OUT_ROOTS) {
      const samples = SAMPLES[def];
      expect([def, samples?.length ?? 0]).not.toEqual([def, 0]);
      const theirs = closureSchema(LOCK.outbound.defs, def);
      for (const s of samples!) {
        expect([def, schema.safeParse(s).success]).toEqual([def, true]);
        expect([def, theirs.safeParse(s).success]).toEqual([def, true]);
      }
    }
  });

  test("对照校验器是真的在校验：缺必填字段、发了枚举外的值都过不了 codex 的 schema", () => {
    const { threadId: _t, ...noThread } = turnStart;
    expect(closureSchema(LOCK.outbound.defs, "v2/TurnStartParams").safeParse(noThread).success).toBe(false);
    expect(closureSchema(LOCK.outbound.defs, "CommandExecutionRequestApprovalResponse").safeParse({ decision: "maybe" }).success).toBe(false);
  });
});

// ---- 合成变异：在已提交的锁上改，断言分级 ----

const clone = (): LockSet => structuredClone(LOCK);
/** 改出站闭包里的一个定义，再像换了新 CLI 那样重算出站投影 */
function mutateOut(name: string, edit: (def: any) => void): LockSet {
  const s = clone();
  edit(s.outbound.defs[name]);
  return { ...s, outbound: buildOutbound(s.outbound.defs) };
}
/** 改入站投影里满足条件的节点（入站只存投影，变异就落在投影上） */
function mutateIn(edit: (n: PNode, def: string, path: string) => PNode | void): LockSet {
  const s = clone();
  for (const [def, nodes] of Object.entries(s.inbound)) for (const [path, n] of Object.entries(nodes)) nodes[path] = edit(n, def, path) ?? n;
  return s;
}
const run = (s: LockSet) => classify(LOCK, s);
const reds = (s: LockSet) => run(s).findings.filter((f) => f.level === "red").map((f) => `${f.where}：${f.why}`);
const memberOf = (def: any, value: string) => def.oneOf.find((m: any) => m.properties.type.enum?.[0] === value);

describe("漂移分级（9 个合成变异）", () => {
  test("没变化 → none", () => {
    expect(run(clone())).toEqual({ level: "none", findings: [] });
  });

  test("1 TurnStartParams 新增必填字段 → 红", () => {
    const s = mutateOut("v2/TurnStartParams", (d) => {
      d.properties.mustSend = { type: "string" };
      d.required.push("mustSend");
    });
    expect(run(s).level).toBe("red");
    expect(reds(s).join("\n")).toContain("新增必填字段 mustSend");
  });

  test("2 ThreadResumeParams.cwd 从可选变成必填 → 红", () => {
    const s = mutateOut("v2/ThreadResumeParams", (d) => void d.required.push("cwd"));
    expect(run(s).level).toBe("red");
    expect(reds(s).join("\n")).toContain("cwd 从可选变成必填");
  });

  test("3 SandboxPolicy 的 dangerFullAccess 分支改名、networkAccess 挪出 workspaceWrite 分支 → 红", () => {
    const renamed = mutateOut("v2/SandboxPolicy", (d) => void (memberOf(d, "dangerFullAccess").properties.type.enum = ["fullAccess"]));
    expect(reds(renamed).join("\n")).toContain("v2/TurnStartParams sandboxPolicy<type=dangerFullAccess>：我们用到的字段或分支没了");
    const moved = mutateOut("v2/SandboxPolicy", (d) => void delete memberOf(d, "workspaceWrite").properties.networkAccess);
    expect(reds(moved).join("\n")).toContain("sandboxPolicy<type=workspaceWrite>.networkAccess");
  });

  test("4 TurnStatus 新增 paused（封闭枚举）→ 红", () => {
    const s = mutateIn((n) => (n.ref === "v2/TurnStatus" ? { ...n, values: [...n.values!, "paused"].sort() } : undefined));
    expect(run(s).level).toBe("red");
    expect(reds(s).join("\n")).toContain("封闭枚举");
  });

  test("5 TurnCompletedNotification 删掉 turn.id → 红", () => {
    const s = mutateIn((n, def, path) => {
      if (def !== "v2/TurnCompletedNotification") return;
      if (path === "turn.id") return { missing: true, ours: n.ours };
      if (path === "turn") return { ...n, keys: Object.fromEntries(Object.entries(n.keys!).filter(([k]) => k !== "id")) };
    });
    expect(reds(s).join("\n")).toContain("v2/TurnCompletedNotification turn.id");
  });

  test("6 TurnStartParams.effort 去掉 null（我们会发 null）→ 红", () => {
    const s = mutateOut("v2/TurnStartParams", (d) => void (d.properties.effort = { $ref: "#/definitions/v2/ReasoningEffort" }));
    expect(reds(s).join("\n")).toContain("effort：我们可能发 null，schema 不收");
  });

  test("7 TurnSteerParams 新增可选字段 → 黄", () => {
    const s = mutateOut("v2/TurnSteerParams", (d) => void (d.properties.note = { type: ["string", "null"] }));
    const r = run(s);
    expect(r.level).toBe("yellow");
    expect(r.findings.map((f) => f.why)).toContain("新增可选字段 note");
  });

  test("8 ThreadItem 新增成员（开放联合）→ 黄", () => {
    const s = mutateIn((n, _def, path) => {
      if (n.ref === "v2/ThreadItem") return { ...n, members: [...n.members!, "newKind"].sort() };
      if (path.endsWith("item.type")) return { ...n, values: [...n.values!, "newKind"].sort() };
    });
    expect(run(s).level).toBe("yellow");
  });

  test("9 只改了一个无关定义（投影、闭包、method 表都没变）→ 候选", () => {
    const s = clone();
    s.lock = { ...s.lock, schemaFullSha256: "0".repeat(64) };
    expect(run(s)).toEqual({ level: "candidate", findings: [expect.objectContaining({ level: "candidate" })] });
  });

  test("附：闭包里只改描述文字 → 黄，并注明只改了描述", () => {
    const s = mutateOut("v2/TurnSteerParams", (d) => void (d.properties.expectedTurnId.description = "改了说明"));
    const r = run(s);
    expect(r.level).toBe("yellow");
    expect(r.findings.map((f) => f.why)).toContain("只改了描述文字");
  });

  test("10 出站收窄：TurnStartParams.model 从任意字符串收窄成枚举或 const → 红，锁也写不进去", () => {
    for (const model of [{ type: ["string", "null"], enum: ["only-allowed-model", null] }, { type: "string", const: "only-allowed-model" }]) {
      const s = mutateOut("v2/TurnStartParams", (d) => void (d.properties.model = model));
      expect(lockProblems(s).join("\n")).toContain("v2/TurnStartParams model：我们发的取值不受限");
      expect(run(s).level).toBe("red");
    }
  });

  test("11 出站收窄：model 加 pattern / maxLength、ReasoningEffort 的 minLength 收紧 → 红", () => {
    const pattern = mutateOut("v2/TurnStartParams", (d) => void (d.properties.model = { type: "string", pattern: "^gpt-" }));
    expect(reds(pattern).join("\n")).toContain("model：schema 限制 pattern=^gpt-");
    const maxLength = mutateOut("v2/TurnStartParams", (d) => void (d.properties.model = { type: "string", maxLength: 8 }));
    expect(reds(maxLength).join("\n")).toContain("model：schema 限制 maxLength=8");
    const effort = mutateOut("v2/ReasoningEffort", (d) => void (d.minLength = 2));
    expect(reds(effort).join("\n")).toContain("effort：schema 限制 minLength=2");
  });
});

/** 合成一个只有字段 v 的出站定义，按我们的 zod 类型投影后查兼容：覆盖各种标量收窄 */
function narrowing(ours: z.ZodType, theirs: object): string[] {
  const defs: Defs = { X: { type: "object", properties: { v: theirs }, required: ["v"] } };
  return compat({ X: project(defs, "X", z.toJSONSchema(z.strictObject({ v: ours })), new Set()) }, "out");
}

describe("出站标量收窄（合成定义）", () => {
  const cases: [string, z.ZodType, object, boolean][] = [
    ["number 对 enum", z.number(), { type: "number", enum: [1, 2] }, false],
    ["integer 对 const", z.number().int(), { type: "integer", const: 3 }, false],
    ["integer 对 minimum（uint32）", z.number().int(), { type: "integer", format: "uint32", minimum: 0 }, false],
    ["有同等范围的 integer", z.number().int().min(0).max(10), { type: "integer", format: "uint32", minimum: 0 }, true],
    ["枚举里的数字字面量", z.literal(1), { type: "number", enum: [1, 2] }, true],
    ["数字字面量超出范围", z.literal(-1), { type: "number", minimum: 0 }, false],
    ["boolean 对 const false", z.boolean(), { type: "boolean", const: false }, false],
    ["false 字面量对 const false", z.literal(false), { type: "boolean", const: false }, true],
    ["string 对 const", z.string(), { type: "string", const: "x" }, false],
    ["string 对 pattern", z.string(), { type: "string", pattern: "^a" }, false],
    ["枚举里有值不满足 pattern", z.enum(["ab", "b"]), { type: "string", pattern: "^a" }, false],
    ["枚举全部满足 pattern", z.enum(["ab"]), { type: "string", pattern: "^a" }, true],
    ["string 对 format", z.string(), { type: "string", format: "uri" }, false],
    ["同等 minLength", z.string().min(1), { type: "string", minLength: 1 }, true],
    ["只发 null 时不看数值约束", z.null(), { type: ["integer", "null"], minimum: 0 }, true],
  ];
  for (const [name, ours, theirs, ok] of cases) {
    test(`${name} → ${ok ? "兼容" : "不兼容"}`, () => {
      const problems = narrowing(ours, theirs);
      if (ok) expect(problems).toEqual([]);
      else expect(problems.length).toBeGreaterThan(0);
    });
  }
});

describe("本机重新生成（设了 CODEX_SCHEMA_CLI 才跑）", () => {
  test.skipIf(!process.env.CODEX_SCHEMA_CLI)(
    "用指定 codex 重新生成锁，和已提交的分级：不能是红",
    () => {
      const r = classify(LOCK, generateLockSet(process.env.CODEX_SCHEMA_CLI!));
      for (const f of r.findings) process.stderr.write(`[${f.level}] ${f.where}：${f.why}\n`);
      expect(r.level).not.toBe("red");
    },
    120_000,
  );
});
