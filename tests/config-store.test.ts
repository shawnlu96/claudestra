import { testChildEnv } from "./test-env.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("card mode survives canonical config read-modify-write; old and invalid configs stay observe", () => {
  const root = mkdtempSync(join(tmpdir(), "ctx1-config-"));
  for (const dir of ["home", "state", "run", "tmp"]) mkdirSync(join(root, dir));
  const modulePath = join(import.meta.dir, "../src/lib/config-store.ts");
  const modePath = join(import.meta.dir, "../src/lib/ctx-boundary-card-worker.ts");
  for (const mode of [undefined, "invalid", "off", "observe", "on"]) {
    writeFileSync(join(root, "state/config.json"), JSON.stringify({ autoCompact: { cardWorkers: mode, window: 456_789, inject: false } }));
    const result = spawnSync(process.execPath, ["--no-env-file", "-e", `
      import {readConfigSync,setAutoCompact} from ${JSON.stringify(modulePath)};
      import {cardBoundaryMode} from ${JSON.stringify(modePath)};
      await setAutoCompact({idleHours: 2});
      const c=readConfigSync().autoCompact;
      console.log(JSON.stringify([cardBoundaryMode(c?.cardWorkers),c?.window,c?.inject,c?.idleHours]));
    `], { encoding: "utf8", env: testChildEnv({
      PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
      CLAUDESTRA_STATE_DIR: join(root, "state"), CLAUDESTRA_RUNTIME_DIR: join(root, "run"),
    }) });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([mode === "on" || mode === "off" ? mode : "observe", 456_789, false, 2]);
  }
});
