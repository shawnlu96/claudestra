import { expect, test } from "bun:test";
import { workerContextProjection } from "../src/bridge/team-worker-context.js";

test("missing facts remain unknown and never imply a zero prompt breakdown", () => {
  const view = workerContextProjection(null, null, null);
  expect(view.remaining).toBeNull();
  expect(view.today).toBeNull();
  expect(view.components).toEqual({ system: null, tools: null, memory: null, messages: null });
  expect(view.overRuntime).toBe(false);
});

test("runtime size and card limit remain separate; equality is card-at-limit", () => {
  const small = workerContextProjection(200_001, 200_000, 1_234);
  expect(small.remaining).toBe(-1);
  expect(small.overRuntime).toBe(true);
  expect(small.cardAtLimit).toBe(false);
  const card = workerContextProjection(300_000, 1_000_000, 7_890, true);
  expect(card.remaining).toBe(700_000);
  expect(card.cardAtLimit).toBe(true);
  expect(card.overRuntime).toBe(false);
  expect(card.estimated).toBe(true);
  expect(workerContextProjection(100, null, 0).remaining).toBeNull();
  expect(workerContextProjection(NaN, Infinity, -1).today).toBeNull();
});

import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { testChildEnv } from "./test-env.ts";

test("isolated real JSONL keeps cache-inclusive daily usage and rejects an old session", () => {
  const root = mkdtempSync(join(tmpdir(), "ctx1-usage-"));
  for (const dir of ["home", "state", "run", "tmp", "repo"]) mkdirSync(join(root, dir));
  const service = join(import.meta.dir, "../src/bridge/team-worker-context.ts");
  const source = join(import.meta.dir, "../src/lib/session-source.ts");
  const script = `
    import {teamWorkerContext} from ${JSON.stringify(service)};
    import {sessionJsonlPath} from ${JSON.stringify(source)};
    import {mkdirSync,writeFileSync} from "node:fs";
    import {dirname} from "node:path";
    const cwd=${JSON.stringify(join(root, "repo"))}, sid="11111111-1111-4111-8111-111111111111";
    writeFileSync(process.env.CLAUDESTRA_STATE_DIR+"/registry.json",JSON.stringify({agents:{"agent-fixture":{
      kind:"worker",status:"active",cwd,sessionId:sid,runtime:"claude-code"
    }}}));
    const path=sessionJsonlPath("claude-code",cwd,sid); mkdirSync(dirname(path),{recursive:true});
    writeFileSync(path,JSON.stringify({type:"assistant",timestamp:new Date().toISOString(),uuid:"fixture-response",
      message:{id:"fixture",model:"claude-sonnet",usage:{input_tokens:10,cache_read_input_tokens:20,
      cache_creation_input_tokens:30,output_tokens:40},content:[]}})+"\\n");
    const good=await teamWorkerContext(new Request("http://fixture/team/worker-context?agent=agent-fixture"));
    const old=await teamWorkerContext(new Request("http://fixture/team/worker-context?agent=agent-fixture&session=old"));
    console.log(JSON.stringify({good:await good.json(),old:old.status}));
  `;
  const r = spawnSync(process.execPath, ["--no-env-file", "-e", script], { encoding: "utf8", env: testChildEnv({
    HOME: join(root, "home"), CLAUDESTRA_STATE_DIR: join(root, "state"),
    CLAUDESTRA_RUNTIME_DIR: join(root, "run"), TMPDIR: join(root, "tmp"),
  }) });
  expect(r.status).toBe(0);
  const result = JSON.parse(r.stdout);
  expect(result.good.used).toBe(60);
  expect(result.good.today).toBe(100);
  expect(result.good.size).toBeNull();
  expect(result.good.remaining).toBeNull();
  expect(result.old).toBe(409);
});
