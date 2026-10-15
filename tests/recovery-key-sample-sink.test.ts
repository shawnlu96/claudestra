/**
 * OBSGATE1 · every recovery key needs a sample sink (lib/recovery-key-defaults-scan.ts over src/lib): a new switch that cannot
 * leave observe samples fails here. The old keys without one sit in LEGACY_NO_SAMPLE_KEYS, a list that may only shrink.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { highRiskRecoveryKey } from "../src/lib/recovery-key-class.js";
import { keysWithoutSampleSink, type ScanSource } from "../src/lib/recovery-key-defaults-scan.js";
import { LEGACY_NO_SAMPLE_KEYS, LEGACY_OBSERVE_KEYS } from "../src/lib/recovery-key-defaults.js";
import { RECOVERY_KEYS, type RecoveryKey } from "../src/lib/recovery-policy.js";

/** The exemption list's length when OBSGATE1 merged. Only ever lower this number (a key that gained a sink leaves the list). */
const LEGACY_NO_SAMPLE_MAX = 43;
const ROOT = join(import.meta.dir, "..");
const HINT = "新开关要有样本记录口：用 gateRecovery 包动作，或 recordObserved 记 observe 样本";

const srcLib = (): ScanSource[] => (readdirSync(join(ROOT, "src/lib"), { recursive: true }) as string[])
  .filter((p) => /\.tsx?$/.test(p)).map((p) => ({ path: relative(ROOT, join(ROOT, "src/lib", p)), text: readFileSync(join(ROOT, "src/lib", p), "utf8") }));

/** The gate's verdict: keys with no sink and no exemption, with the message the test fails with. */
function missingSinks(keys: readonly string[], sources: readonly ScanSource[], exempt: readonly string[] = LEGACY_NO_SAMPLE_KEYS): string[] {
  return keysWithoutSampleSink(keys, sources).filter((k) => !exempt.includes(k)).map((k) => `${k}：${HINT}`);
}
/** The exemption list's own rules: old keys only, never a high-risk new key, never longer than at merge time. */
function exemptionProblems(exempt: readonly string[], max = LEGACY_NO_SAMPLE_MAX): string[] {
  return [
    ...exempt.filter((k) => !LEGACY_OBSERVE_KEYS.includes(k)).map((k) => `${k} 不是老键，不能进豁免清单${highRiskRecoveryKey(k as RecoveryKey) ? "（高风险新键更不行）" : ""}`),
    ...exempt.length > max ? [`豁免清单 ${exempt.length} 个，超过合并时的 ${max} 个：只许缩`] : [],
    ...exempt.length !== new Set(exempt).size ? ["豁免清单有重复"] : [],
  ];
}

describe("recovery key sample sinks (src/lib)", () => {
  test("every key in the table has a sample sink or is an exempt old key", () => {
    expect(missingSinks(RECOVERY_KEYS, srcLib())).toEqual([]);
  });

  test("exemption list: subset of the frozen old keys, no longer than at merge, and every entry still lacks a sink", () => {
    expect(exemptionProblems(LEGACY_NO_SAMPLE_KEYS)).toEqual([]);
    expect(LEGACY_NO_SAMPLE_MAX).toBeLessThanOrEqual(43); // merge-time value; lowering is the only allowed edit
    const gaps = keysWithoutSampleSink(RECOVERY_KEYS, srcLib());
    expect(LEGACY_NO_SAMPLE_KEYS.filter((k) => RECOVERY_KEYS.includes(k as RecoveryKey) && !gaps.includes(k))).toEqual([]); // gained a sink → leave the list
  });
});

describe("the scan's rules (synthetic sources)", () => {
  const KEY = "zzNewSwitch";
  const mech = (body: string): ScanSource => ({ path: "src/lib/zz-new-switch.ts", text: `import { recoveryPolicy } from "./recovery-policy.js";\n${body}` });

  test("[验收线 3] a new key with no sample write fails with the hint; one recordObserved in its file makes it pass", () => {
    const without = mech(`export const go = (p: string) => recoveryPolicy(p, "${KEY}").mode === "on";`);
    expect(missingSinks([KEY], [without])).toEqual([`${KEY}：${HINT}`]);
    expect(missingSinks([KEY], [without])[0]).toContain("要有样本记录口");
    const withSink = mech(`${without.text}\nexport const watch = (db: Database, p: string) => recordObserved(db, { project: p, mechanism: "${KEY}", target: "", actionKey: "a", action: "b" }, 0);`);
    expect(missingSinks([KEY], [withSink])).toEqual([]);
  });

  test("comments never count: a key or a sink call only in comments is no sink", () => {
    const fooled = [
      mech(`// gateRecovery(db, { mechanism: "${KEY}" })\nexport const x = "${KEY}";`),
      mech(`/* recordObserved(db, a, 0) */ export const x = "${KEY}";`),
      mech(`export const go = () => gateRecovery(db, a, act, o);\n/** mechanism: "${KEY}" */`),
      mech(`export const go = () => gateRecovery(db, a, act, o); // "${KEY}"`),
    ];
    for (const s of fooled) expect(keysWithoutSampleSink([KEY], [s])).toEqual([KEY]);
    // `//` inside a string or a regex is not a comment
    expect(keysWithoutSampleSink([KEY], [mech(`const u = "https://x"; const r = /\\/\\//; gateRecovery(db, { mechanism: "${KEY}" }, act, o);`)])).toEqual([]);
  });

  test("other sink shapes: gate, recovery_observe note, ObservedAction for a port, the observe CLI, key constants, adapters", () => {
    const shapes = [
      `gateRecovery(db, { project: p, mechanism: "${KEY}", target: "", actionKey: "a", action: "b" }, act, o);`,
      `appendEvent(db, ctx, { kind: "note", data: { op: "recovery_observe", mechanism: "${KEY}" } });`,
      `const rec: ObservedAction = { project: p, mechanism: "${KEY}", target: "", actionKey: "a", action: "b" }; await port(rec);`,
      `await m("ledger", "scheduler-recovery-observe", id, "--mechanism", "${KEY}");`,
    ];
    for (const s of shapes) expect(keysWithoutSampleSink([KEY], [mech(s)])).toEqual([]);
    // a key constant exported by one file and imported by the file that writes samples
    const decl: ScanSource = { path: "src/lib/zz-keys.ts", text: `export const ZZ_KEY = "${KEY}" as const;` };
    const user: ScanSource = { path: "src/lib/zz-tick.ts", text: `import { ZZ_KEY } from "./zz-keys.js";\nrecordObserved(db, { mechanism: ZZ_KEY }, 0);` };
    expect(keysWithoutSampleSink([KEY], [decl, user])).toEqual([]);
    expect(keysWithoutSampleSink([KEY], [decl])).toEqual([KEY]);
    // the same generic name declared for another key elsewhere is not this key
    const other: ScanSource = { path: "src/lib/zz-other.ts", text: `const KEY = "otherKey" as const;\nrecordObserved(db, { mechanism: KEY }, 0);` };
    const mine: ScanSource = { path: "src/lib/zz-mine.ts", text: `const KEY = "${KEY}" as const;\nexport const m = () => policy(p, KEY);` };
    expect(keysWithoutSampleSink([KEY, "otherKey"], [other, mine])).toEqual([KEY]);
    const adapter: ScanSource = { path: "src/lib/observation-plan-evidence.ts", text: `const ADAPTERS = { "recovery:${KEY}": { observed: q } };` };
    expect(keysWithoutSampleSink([KEY], [adapter])).toEqual([]);
    // the key table and the defaults / class files list every key; they are not mechanisms
    expect(keysWithoutSampleSink([KEY], [{ path: "src/lib/recovery-keys.ts", text: `gateRecovery(); "${KEY}"` }])).toEqual([KEY]);
  });

  test("[验收线 4] the exemption list only shrinks: a non-old key or a larger length constant fails", () => {
    expect(exemptionProblems([...LEGACY_NO_SAMPLE_KEYS.slice(1), KEY])).toEqual([`${KEY} 不是老键，不能进豁免清单`]);
    expect(missingSinks([KEY], [mech("")], [...LEGACY_NO_SAMPLE_KEYS, KEY])).toEqual([]); // why the subset rule exists
    expect(exemptionProblems([...LEGACY_NO_SAMPLE_KEYS, "materials"])).toEqual([`豁免清单 44 个，超过合并时的 43 个：只许缩`]);
    expect(exemptionProblems(LEGACY_NO_SAMPLE_KEYS, 42)).toEqual([`豁免清单 43 个，超过合并时的 42 个：只许缩`]);
    expect(exemptionProblems(LEGACY_NO_SAMPLE_KEYS.slice(1))).toEqual([]); // shrinking is fine
  });
});
