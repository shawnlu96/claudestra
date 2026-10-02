import { expect, test } from "bun:test";
import { parseAsk, parseCommand, parseDTO, parseNode, assertFence } from "../src/lib/shared-ledger-contract-v2";
import { V2_COMMAND_FIXTURES, V2_DTO_FIXTURES, V2_ASK_KIND_FIXTURES } from "../src/lib/shared-ledger-contract-v2-fixtures";
const command = (type: string) => structuredClone(V2_COMMAND_FIXTURES.find(f => f.type === type)!.valid) as any;
const ask = () => structuredClone(V2_DTO_FIXTURES.ask.valid) as any;
test("every business ask kind has a legal and illegal bind fixture", () => {
  for (const fixture of V2_ASK_KIND_FIXTURES) {
    expect(parseAsk(fixture.valid) as unknown).toEqual(fixture.valid);
    expect(() => parseAsk(fixture.invalid)).toThrow("invalid_field");
  }
});
test("dag.bind requires independently supplied task and feature CAS revisions", () => {
  const c = command("dag.bind");
  c.payload.expectedTaskRev = 3;
  expect(parseCommand(c)).toEqual(c);
  for (const rev of [undefined, 0, -1, 1.5, "3"]) {
    const invalid = structuredClone(c); invalid.payload.expectedTaskRev = rev;
    if (rev === undefined) delete invalid.payload.expectedTaskRev;
    expect(() => parseCommand(invalid)).toThrow("invalid_field");
  }
});
for (const kind of ["decide", "owner_action", "accept"] as const) {
  test(`${kind} has no sensitive authorization and retains expiry, answer and audit`, () => {
    const a = { ...ask(), kind, bind: null };
    expect(parseAsk(a)).toEqual(a);
    const c = command("ask.create"); c.payload = { ...c.payload, kind, bind: null, expiresAt: a.expiresAt };
    expect(parseCommand(c)).toEqual(c);
    const answered = { ...a, state: "answered", answeredBy: "person", answeredAt: 2000,
      answer: { kind: "option", optionId: "approve" }, decision: "acknowledged" };
    expect(parseAsk(answered)).toEqual(answered);
    expect(() => parseAsk({ ...a, expiresAt: a.createdAt })).toThrow();
    expect(() => parseAsk({ ...answered, answeredBy: null })).toThrow();
    expect(() => parseAsk({ ...a, bind: ask().bind })).toThrow();
    expect(() => parseCommand({ ...c, payload: { ...c.payload, bind: ask().bind } })).toThrow();
  });
}
test("authorize still requires complete matching content/expiry/action bind", () => {
  const a = ask(); expect(parseAsk(a)).toEqual(a);
  expect(() => parseAsk({ ...a, bind: null })).toThrow();
  const c = command("ask.create"); c.payload.expiresAt = a.expiresAt;
  expect(parseCommand(c)).toEqual(c);
  for (const bind of [null, {}, { ...a.bind, actions: [] }, { ...a.bind, expiresAt: a.expiresAt + 1 }]) {
    expect(() => parseCommand({ ...c, payload: { ...c.payload, bind } })).toThrow();
  }
});
test("V2 DAG uses strict JSON array/object/text parsing before graph validation", () => {
  const dag = structuredClone(V2_DTO_FIXTURES.dag.valid) as any;
  dag.nodes.extra = "unrecognized"; expect(() => parseDTO("dag", dag)).toThrow();
  delete dag.nodes.extra;
  const node = dag.nodes[0];
  expect(() => parseNode({ ...node, oneLine: "bad\u0001text" })).toThrow();
  Object.defineProperty(node, "key", { get: () => "write", enumerable: true });
  expect(() => parseDTO("dag", dag)).toThrow();
  expect(() => parseNode(Object.defineProperty({}, "key", { value: "write", enumerable: false }))).toThrow();
});
test("DAG arrays reject hidden fields and accessor elements", () => {
  const dag = structuredClone(V2_DTO_FIXTURES.dag.valid) as any;
  Object.defineProperty(dag.nodes, "hidden", { value: true });
  expect(() => parseDTO("dag", dag)).toThrow();
  const second = structuredClone(V2_DTO_FIXTURES.dag.valid) as any, node = second.nodes[0];
  Object.defineProperty(second.nodes, "0", { get: () => node, enumerable: true });
  expect(() => parseDTO("dag", second)).toThrow();
});
test("equal malformed fences never pass public assertFence", () => {
  for (const invalid of [{}, { serviceGeneration: 0, epoch: 0, bootId: "" },
    { serviceGeneration: -1, epoch: 1, bootId: "boot" }, { serviceGeneration: 1, epoch: -1, bootId: "boot" },
    { serviceGeneration: 1, epoch: 1, bootId: "" }]) {
    expect(() => assertFence(invalid as any, invalid as any)).toThrow("invalid_field");
  }
});
