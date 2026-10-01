/** i28-A2 §2 GitHub / git 读取：结构化 argv、去掉 GH_REPO、输出严格解析（缺一个字段整轮不动）、文件清单读不全 = null。 */
import { describe, expect, test } from "bun:test";
import { ghEnv, peerPrGithub, type Command } from "../src/lib/peer-pr-github.ts";

const H = "a1".repeat(20);
const ROW = { number: 401, url: "https://github.com/o/r/pull/401", title: "t", author: { login: "He" }, headRefName: "fix/x", headRefOid: H,
  baseRefName: "main", isCrossRepository: false, headRepositoryOwner: { login: "o" }, isDraft: false };

function fake(answers: Record<string, string | { code: number; stdout?: string }>) {
  const calls: { argv: string[]; env: Record<string, string | undefined> }[] = [];
  const command: Command = async (argv, opts) => {
    calls.push({ argv, env: opts.env ?? {} });
    const key = Object.keys(answers).find((k) => argv.join(" ").includes(k));
    const a = key === undefined ? { code: 1, stdout: "" } : answers[key]!;
    const r = typeof a === "string" ? { code: 0, stdout: a } : { code: a.code, stdout: a.stdout ?? "" };
    return { ...r, stderr: r.code ? "boom" : "", timedOut: false } as Awaited<ReturnType<Command>>;
  };
  return { gh: peerPrGithub("/repo", command), calls };
}

describe("peerPrGithub", () => {
  test("listOpen：严格解析，作者 login 原样；url 和仓库对不上整轮作废", async () => {
    const { gh, calls } = fake({ "pr list": JSON.stringify([ROW]) });
    expect(await gh.listOpen("o/r")).toEqual([{ number: 401, url: ROW.url, title: "t", login: "He", branch: "fix/x", head: H, base: "main",
      crossRepo: false, headOwner: "o", draft: false }]);
    expect(calls[0]!.argv.slice(0, 3)).toEqual(["gh", "pr", "list"]);
    expect(calls[0]!.env.GH_REPO).toBeUndefined();
    expect(calls[0]!.env.GH_PROMPT_DISABLED).toBe("1");
    const bad = fake({ "pr list": JSON.stringify([{ ...ROW, url: "https://github.com/x/y/pull/401" }]) });
    await expect(bad.gh.listOpen("o/r")).rejects.toThrow();
    const short = fake({ "pr list": JSON.stringify([{ ...ROW, headRefOid: "abc" }]) });
    await expect(short.gh.listOpen("o/r")).rejects.toThrow();
  });

  test("files：数量对得上才算，改名带旧路径；任何失败 = null", async () => {
    const lines = [{ filename: "src/a.ts", previous_filename: null }, { filename: "src/b.ts", previous_filename: "src/old.ts" }].map((x) => JSON.stringify(x)).join("\n");
    expect(await fake({ changedFiles: '{"changedFiles":2}', "pulls/401/files": lines }).gh.files("o/r", 401))
      .toEqual([{ path: "src/a.ts" }, { path: "src/b.ts", previous: "src/old.ts" }]);
    expect(await fake({ changedFiles: '{"changedFiles":3}', "pulls/401/files": lines }).gh.files("o/r", 401)).toBeNull();
    expect(await fake({ changedFiles: '{"changedFiles":301}' }).gh.files("o/r", 401)).toBeNull();
    expect(await fake({ changedFiles: '{"changedFiles":2}', "pulls/401/files": { code: 1 } }).gh.files("o/r", 401)).toBeNull();
  });

  test("fetchHead：只取 ref，取到的不是卡上的 head 就说为什么", async () => {
    const ok = fake({ fetch: "", "rev-parse": `${H}\n` });
    expect(await ok.gh.fetchHead(401, H)).toBeNull();
    expect(ok.calls[0]!.argv).toEqual(["git", "-C", "/repo", "fetch", "--no-tags", "origin", "+refs/pull/401/head:refs/claudestra/peer-pr/401"]);
    expect(await fake({ fetch: "", "rev-parse": `${"b".repeat(40)}\n` }).gh.fetchHead(401, H)).toContain("不是卡上的");
  });

  test("view：状态只认三种；作者 / draft 缺一个就整轮不动", async () => {
    const v = { state: "MERGED", url: ROW.url, author: { login: "He" }, title: "t", headRefOid: H, baseRefName: "main", headRefName: "fix/x",
      isCrossRepository: false, headRepositoryOwner: { login: "o" }, isDraft: false };
    expect(await fake({ "pr view": JSON.stringify(v) }).gh.view("o/r", 401)).toEqual({ state: "MERGED", url: ROW.url, login: "He", title: "t", head: H,
      base: "main", branch: "fix/x", crossRepo: false, headOwner: "o", draft: false });
    await expect(fake({ "pr view": JSON.stringify({ ...v, state: "DRAFT" }) }).gh.view("o/r", 401)).rejects.toThrow();
    await expect(fake({ "pr view": JSON.stringify({ ...v, isDraft: undefined }) }).gh.view("o/r", 401)).rejects.toThrow();
    await expect(fake({ "pr view": JSON.stringify({ ...v, author: null }) }).gh.view("o/r", 401)).rejects.toThrow();
  });

  test("ghEnv 清掉 agent 频道和调度身份", () => {
    const env = ghEnv({ GH_REPO: "x/y", DISCORD_CHANNEL_ID: "1", CLAUDESTRA_SCHEDULER_SERVICE: "1", PATH: "/bin" });
    expect(env).toEqual({ PATH: "/bin", GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "" });
  });
});
