import { afterAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCommand, parseReceipt, parseTask } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_COMMAND_FIXTURES, V2_DTO_FIXTURES } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { matchV2Route, parsePathId, V2_ROUTES } from "../src/lib/shared-ledger-contract-v2-routes.js";
import { branch, id, relativeGlob, relativePath } from "../src/lib/shared-ledger-contract-v2-validation.js";
import { createStage2Transport, type Stage2Connection } from "../src/lib/shared-ledger-v2-transport.js";
import { testChildEnv } from "./test-env.js";

const validBranches = ["feat/issue#123", "feat/100%", "main", "@", "feat/right]", "feat/中文", "feat/non\u00a0breaking",
  "feat/dot./child", "feat/-option", "feat/foo.locked", "feat/foo.LOCK"];
const invalidBranches = [".hidden", "feat/.hidden", "feat/trailing.", "feat/foo.lock/bar", "-option", "HEAD",
  "", "/main", "main/", "feat//main", "feat/../main", "feat/a..b", "feat/foo.lock", "feat/a@{b", "@{-1}", "@{-2}",
  "feat/a b", "feat/a\tb", "feat/a\nb", "feat/a\rb", "feat/a\u0001b", "feat/a\u007fb", "feat/a~b", "feat/a^b",
  "feat/a:b", "feat/a?b", "feat/a*b", "feat/a[b", "feat/a\\b"];
const gitDir = mkdtempSync(join(tmpdir(), "ctid1-git-"));
afterAll(() => rmSync(gitDir, { recursive: true, force: true }));

function lendWith(name: string) {
  const fixture = structuredClone(V2_COMMAND_FIXTURES.find(f => f.type === "lend.create")!.valid);
  return { ...fixture, payload: { ...fixture.payload, step: "write", branch: name, base: name } };
}

for (const name of validBranches) {
  test(`[验收线 1] branch/task/lend.create accept ${JSON.stringify(name)}`, () => {
    expect(branch(name)).toBe(name);
    expect(parseTask({ ...V2_DTO_FIXTURES.task.valid as object, branch: name }).branch).toBe(name);
    expect(parseCommand(lendWith(name))).toMatchObject({ payload: { branch: name, base: name } });
  });
}
for (const name of invalidBranches) {
  test(`[验收线 1] branch/task/lend.create reject ${JSON.stringify(name)}`, () => {
    expect(() => branch(name)).toThrow("invalid_field");
    expect(() => parseTask({ ...V2_DTO_FIXTURES.task.valid as object, branch: name })).toThrow("invalid_field");
    for (const field of ["branch", "base"]) {
      const c = lendWith("main");
      expect(() => parseCommand({ ...c, payload: { ...c.payload, [field]: name } })).toThrow("invalid_field");
    }
  });
}
for (const name of [...validBranches, ...invalidBranches]) {
  test(`[验收线 1] local git --branch agrees for ${JSON.stringify(name)}`, () => {
    const result = Bun.spawnSync(["git", "check-ref-format", "--branch", name], { cwd: gitDir,
      env: testChildEnv({ HOME: gitDir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }),
      stdout: "ignore", stderr: "ignore" });
    expect([name, result.exitCode === 0]).toEqual([name, validBranches.includes(name)]);
  });
}
test("[验收线 1] preserve branch length and resource/glob domains", () => {
  expect(branch("a".repeat(500))).toHaveLength(500);
  expect(() => branch("a..b")).toThrow("invalid_field");
  for (const value of ["a".repeat(501), null, 123, {}, "a\0b"]) expect(() => branch(value)).toThrow("invalid_field");
  for (const name of ["feat/issue#123", "feat/100%"]) expect(() => relativePath(name)).toThrow("invalid_field");
  expect(relativePath("feat/.hidden")).toBe("feat/.hidden");
  expect(relativeGlob("src/**/some file?.ts")).toBe("src/**/some file?.ts");
  expect(() => relativeGlob("src/../*.ts")).toThrow("invalid_field");
});

const scope = { teamId: "team..one", projectId: "project..one" };
const digest = "a".repeat(64);
const query = { requestId: "request..001", operationId: "operation..001", commandDigest: digest };
const root = "/v2/teams/team..one/projects/project..one";
for (const value of ["request..001", "project..one", "team..one", "a..b", "a...", "a:b-c_d.e", "a".repeat(128)]) {
  test(`[验收线 2] path and query ids share the ordinary id domain: ${value}`, () => {
    expect(parsePathId(value)).toBe(id(value));
    const params = { ...scope, ...query, requestId: value, operationId: value };
    const path = V2_ROUTES.receipts.path(params);
    expect(matchV2Route("GET", path)).toEqual({ name: "receipts", params });
  });
}
test("[验收线 2] commands and every id-bearing route round-trip embedded dots", () => {
  expect(V2_ROUTES.commands.path(scope)).toBe(`${root}/commands`);
  expect(matchV2Route("POST", `${root}/commands`)).toEqual({ name: "commands", params: scope });
  for (const [name, key] of [["asks", "askId"], ["features", "featureId"], ["lend", "orderId"],
    ["migration", "batchId"], ["revert", "batchId"]] as const) {
    const params = { ...scope, [key]: "entity..one" };
    const route = V2_ROUTES[name];
    expect(matchV2Route(route.method, route.path(params as never))).toEqual({ name, params });
  }
});
const invalidIds = ["a/b", "..", ".", "a/../b", "../project", "a\\b", "%2e%2e", "%2E%2E%2Fproject",
  "a%2fb", "a%5Cb", "%252e%252e", "", " team", "team?x", "team#x", "a".repeat(129)];
for (const value of invalidIds) {
  test(`[验收线 2] reject separators and traversal: ${value}`, () => {
    expect(() => id(value)).toThrow("invalid_field");
    expect(() => parsePathId(value)).toThrow("invalid_field");
    for (const field of ["teamId", "projectId", "requestId", "operationId"]) {
      expect(() => V2_ROUTES.receipts.path({ ...scope, ...query, [field]: value })).toThrow("invalid_field");
    }
    expect(matchV2Route("POST", `/v2/teams/${value}/projects/project/commands`)).toBeNull();
    expect(matchV2Route("POST", `/v2/teams/team/projects/${value}/commands`)).toBeNull();
    expect(matchV2Route("GET", `${root}/receipts/${value}?commandDigest=${digest}`)).toBeNull();
    expect(matchV2Route("GET", `${root}/receipts/request?operationId=${value}&commandDigest=${digest}`)).toBeNull();
  });
}
test("[验收线 2] fake signed transport submits and queries receipts with embedded dots", async () => {
  const key = generateKeyPairSync("ed25519");
  const paths: string[] = [];
  const c = parseCommand({ ...V2_COMMAND_FIXTURES.find(f => f.type === "task.set")!.valid, ...scope, requestId: query.requestId });
  const receipt = parseReceipt({ ...V2_DTO_FIXTURES.receipt.valid as object, ...scope, requestId: query.requestId, commandDigest: digest });
  const named = { ...receipt, result: { ...receipt.result, operationId: query.operationId } };
  const fetch: NonNullable<Stage2Connection["fetch"]> = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input as Request, init), url = new URL(req.url);
    paths.push(`${req.method} ${url.pathname}${url.search}`);
    expect(matchV2Route(req.method, url.pathname + url.search)).not.toBeNull();
    if (req.method === "POST") { expect(await req.json()).toEqual(c); return Response.json(receipt); }
    return Response.json({ ...scope, requestId: query.requestId, status: "committed", receipt: named });
  }) as NonNullable<Stage2Connection["fetch"]>;
  const t = createStage2Transport({ connection: { centerId: "center", baseUrl: "https://center.invalid", teamId: scope.teamId,
    personId: "person", instanceId: "local", bearer: "synthetic-ctid1-bearer" }, projectId: scope.projectId,
    key: { privateKey: key.privateKey, publicKey: String(key.publicKey.export({ format: "jwk" }).x) }, fetch });
  expect(await t.call("commands", {}, c)).toEqual(receipt);
  for (const operationId of [query.operationId, null]) {
    expect((await t.receipt({ ...query, operationId })).receipt).toEqual(named);
  }
  expect(paths).toEqual([`POST ${root}/commands`,
    `GET ${root}/receipts/request..001?operationId=operation..001&commandDigest=${digest}`,
    `GET ${root}/receipts/request..001?commandDigest=${digest}`]);
  for (const value of invalidIds) {
    await expect(t.call("commands", {}, { ...c, requestId: value })).rejects.toThrow("invalid_field");
    await expect(t.receipt({ ...query, requestId: value })).rejects.toThrow("invalid_field");
    await expect(t.receipt({ ...query, operationId: value })).rejects.toThrow("invalid_field");
  }
  expect(paths).toHaveLength(3);
});
