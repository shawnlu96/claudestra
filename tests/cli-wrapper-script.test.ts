import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cliWrapperScript as publicWrapper, DAEMONS as publicDaemons } from "../src/lib/cli-install.js";
import { cliWrapperScript, DAEMONS, systemdUnitHint } from "../src/lib/cli-wrapper.js";
import { testChildEnv } from "./test-env.ts";

// Runtime-invalid values deliberately preserve the old coercion behavior; no new validation is part of this move.
const VALUES: unknown[] = [
  "/opt/claudestra", "", "/目录 空格/🧪", "/quote\"'\\$HOME`x`\n\r\t\0", "./relative/../repo",
  undefined, null, 7, { unknown: true }, ["repeat", "repeat"],
];

describe("systemd hint extraction", () => {
  test("100 input pairs retain the pre-extraction output bytes", () => {
    const results = VALUES.flatMap(repo => VALUES.map(bun => ({
      output: systemdUnitHint(repo as string, bun as string),
    })));
    // SHA-256 of JSON.stringify(results), captured from 4da2254170 cli-install.ts before moving the function.
    expect(results).toHaveLength(100);
    expect(createHash("sha256").update(JSON.stringify(results)).digest("hex"))
      .toBe("3e1dd845f9f14ed5e349683e5c2e53c027e541e9866a48f4191cbc6d4f7688f4");
  });

  test("coercion order, repeated interpolation and exceptions stay unchanged", () => {
    const calls: string[] = [];
    const value = (name: string) => ({ toString() { calls.push(name); return name; } }) as unknown as string;
    systemdUnitHint(value("repo"), value("bun"));
    expect(calls).toEqual(["bun", "repo", "repo", "repo"]);
    const failure = new Error("synthetic coercion failure");
    const bad = { toString() { throw failure; } } as unknown as string;
    calls.length = 0;
    expect(() => systemdUnitHint(value("repo"), bad)).toThrow(failure);
    expect(calls).toEqual([]);
    expect(() => systemdUnitHint(bad, value("bun"))).toThrow(failure);
    expect(calls).toEqual(["bun"]);
    expect(() => systemdUnitHint(Symbol("repo") as unknown as string, "bun")).toThrow(TypeError);
  });

  test("wrapper and daemon public exports still reuse the canonical module", () => {
    expect(publicWrapper).toBe(cliWrapperScript);
    expect(publicDaemons).toBe(DAEMONS);
    expect(publicWrapper("/opt/claudestra")).toBe(cliWrapperScript("/opt/claudestra", "bun"));
    for (const repo of VALUES) for (const bun of VALUES) {
      expect(Buffer.from(publicWrapper(repo as string, bun as string)))
        .toEqual(Buffer.from(cliWrapperScript(repo as string, bun as string)));
    }
  });
});

// Module mocks and platform substitution live in a disposable process so other suites keep their actual dependencies.
const FAKE_BUN = "/合成 bun/bin/bun";
const REPOS = ["", "/opt/repo", "/目录 空格/🧪", "/quote\"'\\$HOME`x`\n"];
const OPTIONS = [undefined, {}, { skipWebBuild: true }, { unknown: "ignored" }, null];
const LIB = resolve(import.meta.dir, "../src/lib");
const PROBE = `
import { mock } from "bun:test";
let bunCalls = 0;
mock.module(${JSON.stringify(join(LIB, "bun-path.ts"))}, () => ({
  resolveBunPath: () => { bunCalls++; return ${JSON.stringify(FAKE_BUN)}; },
}));
const { installClaudestraCli } = await import(${JSON.stringify(join(LIB, "cli-install.ts"))});
const rows = [];
for (const platform of ["linux", "win32"]) {
  Object.defineProperty(process, "platform", { value: platform });
  for (const repo of ${JSON.stringify(REPOS)}) {
    for (const opts of [undefined, {}, { skipWebBuild: true }, { unknown: "ignored" }, null]) {
      rows.push({ platform, repo, result: await installClaudestraCli(repo, opts) });
    }
  }
}
const invalid = [];
for (const repo of [undefined, null, 7]) {
  try { await installClaudestraCli(repo); invalid.push("unexpected success"); }
  catch (error) { invalid.push(error.name); }
}
console.log(JSON.stringify({ rows, invalid, bunCalls }));
`;

test("actual install public entry returns the leaf hint with unchanged result fields on non-macOS", () => {
  const home = mkdtempSync(join(tmpdir(), "clip-public-"));
  try {
    const child = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", "-e", PROBE], {
      cwd: home, stdout: "pipe", stderr: "pipe",
      env: testChildEnv({
        HOME: home, TMPDIR: home, CLAUDESTRA_STATE_DIR: join(home, "state"), CLAUDESTRA_RUNTIME_DIR: join(home, "runtime"),
      }),
    });
    expect(child.exitCode).toBe(0);
    expect(child.stderr.toString()).toBe("");
    const got = JSON.parse(child.stdout.toString());
    expect(got.bunCalls).toBe(2 * REPOS.length * OPTIONS.length);
    expect(got.invalid).toEqual(["TypeError", "TypeError", "TypeError"]);
    const expected = ["linux", "win32"].flatMap(platform => REPOS.flatMap(repo => OPTIONS.map(() => ({
      platform, repo,
      result: {
        cliWrapper: "", daemons: [], web: { staticDir: "", built: false }, pm2Stopped: [],
        removedOldAutostartWrapper: false, migratedHookCommand: false,
        errors: [
          `进程守护当前只实现了 macOS launchd，检测到 ${platform}。\n` +
          `Claudestra 本身能在 Linux 上跑（bridge / launcher / cron / scheduler 都是普通 Bun 进程），\n` +
          `只是需要你自己接管开机自启。用 systemd 的话，为这四个服务各建一个 user unit：\n\n` +
          systemdUnitHint(resolve(home, repo), FAKE_BUN) +
          `\n然后 systemctl --user daemon-reload && systemctl --user enable --now claudestra-bridge`,
        ],
        warnings: [],
      },
    }))));
    // String comparison also locks down field order, whitespace and newlines at the original public boundary.
    expect(JSON.stringify(got.rows)).toBe(JSON.stringify(expected));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
