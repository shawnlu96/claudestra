/**
 * The dynamic-load / implicit-input registration check (merge-arch-CIPRECHK1), shared by tests/ci-impact-io-map.test.ts and the
 * delivery precheck (ci-deliver-precheck.ts): over one tree's import graph, what the selector would refuse whatever changed — an
 * unregistered non-literal load reachable from a test, an unknown local spec, a parse error. Read-map rules (measured), so plain
 * repo io is no problem here; IMPLICIT_INPUTS / KNOWN_UNRESOLVED in ci-impact-inputs.ts are the only registry. Empty = registered.
 * treeImpact is the precheck's whole selector call (CI's responsibility rules: mode on, no read map), kept in the selector family.
 */
import { buildGraph, isTestFile, oxcScanner, type OxcParseSync, tsconfigAliases } from "./ci-impact-graph.js";
import { DEFAULT_IMPACT_INPUTS, type ImpactInputs } from "./ci-impact-inputs.js";
import { type ImpactSelection, type ImpactSide, parseNameStatus, proposeTests, selectImpactedTests } from "./ci-impact-select.js";

export { MODULE_FILE } from "./ci-impact-graph.js";

export function registrationProblems(side: ImpactSide, inputs: ImpactInputs = DEFAULT_IMPACT_INPUTS): string[] {
  const probe = side.paths.find(isTestFile);
  if (!probe) return ["没有测试文件，无从检查登记"];
  // a modified test file is a plain seed: every reason left is a graph fact, the same ones a real batch would hit
  return proposeTests([{ status: "M", path: probe }], side, side, inputs, []).reasons;
}

export interface TreeImpactInput {
  headPaths: string[];
  basePaths: string[];
  readHead: (path: string) => string;
  readBase: (path: string) => string;
  /** `git diff -z --name-status -M <base> <head>` */
  nameStatus: string;
  parseSync: OxcParseSync;
}

/** base / head graphs → the on-mode selection, the changed tests still in head, and the registration check over head */
export function treeImpact(i: TreeImpactInput): { sel: ImpactSelection; changedTests: string[]; registration: string[] } {
  const scan = oxcScanner(i.parseSync);
  const side = (paths: string[], read: (p: string) => string): ImpactSide =>
    ({ paths, graph: buildGraph({ paths, read }, scan, tsconfigAliases(read("tsconfig.json"))) });
  const head = side(i.headPaths, i.readHead), base = side(i.basePaths, i.readBase);
  const d = parseNameStatus(i.nameStatus);
  const sel = selectImpactedTests({ mode: "on", changes: d.changes, badChanges: d.bad, headPaths: i.headPaths, load: () => ({ base, head }) });
  const inHead = new Set(i.headPaths);
  const changedTests = [...new Set(d.changes.filter((c) => c.status !== "D" && isTestFile(c.path) && inHead.has(c.path)).map((c) => c.path))].sort();
  return { sel, changedTests, registration: registrationProblems(head) };
}
