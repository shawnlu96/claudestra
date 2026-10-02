import { expect, test } from "bun:test";
import { parseDag, parseCommand, relativePath } from "../src/lib/shared-ledger-contract-v2";
import { command } from "./shared-ledger-v2-tasks-harness.test";
const node = (glob: unknown) => ({ key: "write", oneLine: "Task", deps: [], fileGlobs: [glob], estimate: "1h" });
test("DAG fileGlobs accept wildcard question marks, spaces, classes and braces", () => {
  for (const glob of ["src/file?.ts", "src/file name.ts", "src/[ab].ts", "src/{a,b}.ts", "src/**/*.ts"]) {
    expect(parseDag({ version: 1, nodes: [node(glob)], bindings: [] }).nodes[0].fileGlobs).toEqual([glob]);
    expect(parseCommand({ ...command("dag.init"), payload: { ...command("dag.init").payload, nodes: [node(glob)] } }).type).toBe("dag.init");
  }
});
test("glob path safety and the separate resource/link path restrictions remain intact", () => {
  for (const glob of [null, 1, "", "/src/file", "C:/src/file", "~/src/file", "../src/file", "src/../file", "src/./file",
    "src//file", "src/\u0000file", "src/\tfile", "src/\nfile", "src/\u007ffile", "a".repeat(501), "src\\file", "%2e%2e/file"]) {
    expect(() => parseDag({ version: 1, nodes: [node(glob)], bindings: [] })).toThrow();
  }
  for (const path of ["src/file?.ts", "src/file name.ts", "/src/file", "../src/file"]) expect(() => relativePath(path)).toThrow();
});
