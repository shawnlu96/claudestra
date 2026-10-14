/** PEERINFO1 [验收线 4]：peer-info 列表与 --has（真 git 仓库，只跑本地命令；本机没有对方 commit 时固定提示，不 fetch）。 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdPeerInfo, containsVerdict, NO_PEER_COMMIT_LOCAL, parsePeerInfoArgs, type LocalGit } from "../src/manager/peer-info-cmds";

let dir = "";
let A = "", B = "", C = "";
const seen: string[][] = [];
const git: LocalGit = (args) => {
  seen.push(args);
  return Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "ignore", stderr: "ignore" }).exitCode ?? -1;
};
const sh = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
  { cwd: dir, stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "peerinfo-git-"));
  sh("init", "-q", "-b", "main");
  sh("commit", "-q", "--allow-empty", "-m", "a"); A = sh("rev-parse", "HEAD");
  sh("commit", "-q", "--allow-empty", "-m", "b"); B = sh("rev-parse", "HEAD");
  sh("checkout", "-q", "-b", "side", A);
  sh("commit", "-q", "--allow-empty", "-m", "c"); C = sh("rev-parse", "HEAD");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("--has", () => {
  test("本机有对方 commit：包含 / 不包含", () => {
    expect(containsVerdict(git, B, A)).toBe("包含");
    expect(containsVerdict(git, B, B.slice(0, 12))).toBe("包含");
    expect(containsVerdict(git, B, C)).toBe("不包含");
  });

  test("本机没有对方 commit：固定提示，只跑本地命令（不 fetch）", () => {
    seen.length = 0;
    expect(containsVerdict(git, "f".repeat(40), A)).toBe(NO_PEER_COMMIT_LOCAL);
    expect(seen.flat()).not.toContain("fetch");
    expect(seen.every((a) => a[0] === "cat-file" || a[0] === "merge-base")).toBe(true);
  });

  test("参数：--has 要十六进制提交号", () => {
    expect(parsePeerInfoArgs(["peer-a", "--has", "ABCDEF1"])).toEqual({ peer: "peer-a", has: "abcdef1" });
    expect("error" in parsePeerInfoArgs(["--has", "HEAD"])).toBe(true);
  });
});

test("列表：version、commit 前 12 位、channel、switches、取到时间；没带 instance 的 peer 如实说", async () => {
  const path = join(dir, "peer-presence.json");
  writeFileSync(path, JSON.stringify({ updatedAt: "t", peers: {
    "peer-a": { online: true, instance: { version: "2.33.0", commit: B, channel: "beta", switches: { lendUiUpload: "on" } }, instanceAt: "2026-10-14T05:00:00.000Z" },
    "peer-b": { online: true },
  } }));
  const out: string[] = [];
  await cmdPeerInfo(["--has", A], { path, git, out: (s) => out.push(s) });
  expect(out.join("\n")).toBe([
    `peer-a  version 2.33.0 · commit ${B.slice(0, 12)} · channel beta · switches lendUiUpload=on · 取到 2026-10-14T05:00:00.000Z`,
    `  含 ${A.slice(0, 12)}：包含`,
    "peer-b  对方没带 instance（没升级，或对方 peerInstanceInfo 不是 on）",
  ].join("\n"));
  out.length = 0;
  await cmdPeerInfo(["peer-b"], { path, git, out: (s) => out.push(s) });
  expect(out).toEqual(["peer-b  对方没带 instance（没升级，或对方 peerInstanceInfo 不是 on）"]);
});
