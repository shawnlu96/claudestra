/** POOLRV1 r1: the received-request archive (src/lib/pool-review-proof-raw.ts) and the bridge's strict decode, on temp dirs only. */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rawProblem, readRawResult, saveRawResult, strictUtf8 } from "../src/lib/pool-review-proof-raw.js";

const dir = () => join(mkdtempSync(join(tmpdir(), "poolrv-raw-")), "lend-raw");
const TEXT = "﻿{\"report\":\"〔原始报告〕\\r\\nsecond\"}\r\n";

describe("strictUtf8", () => {
  test("valid bytes decode losslessly (BOM and CRLF kept); invalid UTF-8 is refused, never replaced", () => {
    const bytes = Buffer.from(TEXT, "utf8");
    const text = strictUtf8(bytes)!;
    expect(Buffer.from(text, "utf8").equals(bytes)).toBe(true);
    expect(strictUtf8(Buffer.from([0x7b, 0xff, 0x7d]))).toBeNull();
    expect(strictUtf8(Buffer.from([0xe4, 0xb8]))).toBeNull(); // truncated sequence
  });
});

describe("saveRawResult / rawProblem", () => {
  test("content-hash name, dir 0700, file 0600, bytes intact; the same text again is the same file", () => {
    const d = dir();
    const ref = saveRawResult(d, TEXT);
    const sha = createHash("sha256").update(Buffer.from(TEXT, "utf8")).digest("hex");
    expect(ref).toEqual({ sha256: sha, path: join(d, `${sha}.json`), bytes: Buffer.byteLength(TEXT) });
    expect(statSync(d).mode & 0o777).toBe(0o700);
    expect(statSync(ref.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(ref.path).equals(Buffer.from(TEXT, "utf8"))).toBe(true);
    expect(saveRawResult(d, TEXT)).toEqual(ref);
    expect(readdirSync(d)).toEqual([`${sha}.json`]); // no temp files left
    expect(rawProblem(ref)).toBeNull();
    expect(readRawResult(ref)).toBe(TEXT);
  });

  test("an existing file under that name with other bytes is never overwritten", () => {
    const d = dir();
    const ref = saveRawResult(d, TEXT);
    chmodSync(ref.path, 0o600);
    writeFileSync(ref.path, "other");
    expect(() => saveRawResult(d, TEXT)).toThrow(/不覆盖/);
    expect(readFileSync(ref.path, "utf8")).toBe("other");
  });

  test("missing, altered, wrongly named or group-readable archives are not intact", () => {
    const d = dir();
    const ref = saveRawResult(d, TEXT);
    expect(rawProblem({ ...ref, path: join(d, "x.json") })).toMatch(/内容哈希命名/);
    expect(rawProblem({ ...ref, bytes: ref.bytes + 1 })).toMatch(/对不上/);
    chmodSync(ref.path, 0o640);
    expect(rawProblem(ref)).toMatch(/普通文件/);
    chmodSync(ref.path, 0o600);
    writeFileSync(ref.path, TEXT.replace("second", "SECOND"));
    expect(rawProblem(ref)).toMatch(/对不上/);
    expect(readRawResult(ref)).toBeNull();
    expect(rawProblem({ ...ref, sha256: "0".repeat(64), path: join(d, `${"0".repeat(64)}.json`) })).toMatch(/缺失/);
  });
});
