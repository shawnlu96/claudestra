/**
 * rename-floka-REPOALIAS1：新旧仓库名归一（src/lib/repo-alias.ts）与它接入的比较点——交付查 PR（order-deliver-pr）、
 * 合并核验（scheduler-merge-external inspect）、外仓判定（scheduler-foreign-repo）、私仓前缀 / clone（card-repo）。
 * 档位 off / observe 与改前逐字一致，observe 在结论不同时每个调用点每小时只记一行；on 才把旧名、新名当同一个仓库。
 * ledger verify 与 peer PR 收卡在 tests/repo-alias-ledger.test.ts。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cardRepo as cardRepoOf, repoDirFor, repoOfGlobs, stripRepoPrefix, type RepoDirIO } from "../src/lib/card-repo.js";
import { OFFICIAL_REPO, PROPOSED_REPO } from "../src/lib/floka-repo/migrate.js";
import { deliverPrPatch, prConflict, prInRepo } from "../src/lib/order-deliver-pr.js";
import type { ObservedAction } from "../src/lib/recovery-policy.js";
import { aliasPick, canonicalRepo, prKey, repoAllowed, samePr, sameRepo, setRepoAliasForTest } from "../src/lib/repo-alias.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { foreignRepoOf, isForeignRepoError } from "../src/lib/scheduler-foreign-repo.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import type { runBounded } from "../src/lib/run-bounded.js";

const OLD = OFFICIAL_REPO, NEW = PROPOSED_REPO;
const pr = (repo: string, n = 12, tail = "") => `https://github.com/${repo}/pull/${n}${tail}`;
const MODES = ["off", "observe", "on"] as const;

let lines: ObservedAction[] = [];
const mode = (m: (typeof MODES)[number]) => { lines = []; setRepoAliasForTest({ mode: m, sink: (a) => lines.push(a) }); };
afterEach(() => setRepoAliasForTest({ mode: null, sink: null }));

describe("[验收线 1] canonicalRepo / sameRepo / samePr", () => {
  test("新旧名、大小写、PR 尾斜杠等价；常量就是 floka-repo 的两个", () => {
    expect([OLD, NEW]).toEqual(["shawnlu96/claudestra", "floka-ai/floka"]);
    expect(canonicalRepo(OLD)).toBe(NEW);
    expect(canonicalRepo("ShawnLu96/Claudestra")).toBe(NEW);
    expect(canonicalRepo("Floka-AI/Floka")).toBe(NEW);
    expect(canonicalRepo("Some/Other")).toBe("some/other");
    expect(sameRepo(OLD, NEW)).toBe(true);
    expect(sameRepo("FLOKA-AI/floka", "shawnlu96/CLAUDESTRA")).toBe(true);
    expect(repoAllowed(NEW, [OLD, "x/y"])).toBe(true);
    expect(samePr(pr(OLD), pr(NEW))).toBe(true);
    expect(samePr(pr(OLD, 12, "/"), pr("Floka-AI/Floka"))).toBe(true);
    expect(prKey(pr(OLD, 7))).toBe("floka-ai/floka#7");
  });

  test("不同仓库同编号、同仓库不同编号都不等价", () => {
    expect(samePr(pr(OLD, 12), pr(OLD, 13))).toBe(false);
    expect(samePr(pr(NEW, 12), pr("shawnlu96/claudestra-relay", 12))).toBe(false);
    expect(samePr(pr("a/b", 12), pr("a/c", 12))).toBe(false);
  });

  test("别的 owner 的仓库、别的组织的 floka、fork 都不借别名", () => {
    for (const other of ["shawnlu96/other", "evil/floka", "floka-ai/floka-fork", "floka-ai/claudestra", "shawnlu96/floka", "evil/claudestra"]) {
      expect([other, sameRepo(other, OLD), sameRepo(other, NEW)]).toEqual([other, false, false]);
      expect([other, samePr(pr(other), pr(OLD)), samePr(pr(other), pr(NEW))]).toEqual([other, false, false]);
      expect(repoAllowed(other, [OLD, NEW])).toBe(false);
    }
  });

  test("非 github.com 主机、畸形 URL、畸形仓库名 → null / false", () => {
    const bad = [
      "https://gitlab.com/shawnlu96/claudestra/pull/12", "https://github.com.evil.io/floka-ai/floka/pull/12", "http://github.com/floka-ai/floka/pull/12",
      "https://GitHub.com/floka-ai/floka/pull/12", "https://github.com/floka-ai/floka/pull/0", "https://github.com/floka-ai/floka/pull/-1",
      "https://github.com/floka-ai/floka/pull/1.5", "https://github.com/floka-ai/floka/pull/12/files", "https://github.com/floka-ai/floka/issues/12",
      "https://github.com/floka-ai/floka/pull/12?x=1", "https://github.com/floka-ai/../pull/12", "https://user@github.com/floka-ai/floka/pull/12",
      " https://github.com/floka-ai/floka/pull/12", "https://github.com/floka-ai/floka/pull/99999999999999999999", "#12", "12", "",
    ];
    for (const u of bad) {
      expect([u, prKey(u)]).toEqual([u, null]);
      expect([u, samePr(u, pr(NEW)), samePr(u, u)]).toEqual([u, false, false]);
    }
    expect(prKey(null)).toBeNull();
    for (const r of ["floka-ai", "floka-ai/floka/x", " floka-ai/floka", "floka-ai/floka.git/", "", null, undefined]) {
      expect(canonicalRepo(r)).toBeNull();
      expect(sameRepo(r, r)).toBe(false);
    }
  });
});

describe("[验收线 6] aliasPick：off / observe 逐字，observe 同一调用点每小时一行，on 归一", () => {
  test("两种结论相同不读档位、不记日志", () => {
    mode("observe");
    expect(aliasPick("s", true, true)).toBe(true);
    expect(aliasPick("s", false, false)).toBe(false);
    expect(lines).toEqual([]);
  });
  test("结论不同：off 逐字不记；observe 逐字并记一行，同点一小时内不重复、别的点照记、过一小时再记；on 归一", () => {
    mode("off");
    expect(aliasPick("s", false, true, Object.is, 0)).toBe(false);
    expect(lines).toEqual([]);
    mode("observe");
    expect(aliasPick("s", false, true, Object.is, 0)).toBe(false);
    expect(aliasPick("s", false, true, Object.is, 1_000)).toBe(false);
    expect(aliasPick("t", false, true, Object.is, 2_000)).toBe(false);
    expect(lines.map((l) => [l.mechanism, l.actionKey])).toEqual([["repoAlias", "s"], ["repoAlias", "t"]]);
    expect(lines[0]!.action).toContain("observe s");
    expect(aliasPick("s", false, true, Object.is, 3_600_001)).toBe(false);
    expect(lines).toHaveLength(3);
    mode("on");
    expect(aliasPick("s", false, true)).toBe(true);
    expect(lines).toEqual([]);
  });
});

describe("[验收线 2] order-deliver-pr：prInRepo / prConflict", () => {
  test("档位 on：origin 旧名认 GitHub 新名 PR；卡上旧名 URL 与同编号新名 URL 是同一个 PR，交付不改写卡上的原值", () => {
    mode("on");
    expect(prInRepo(pr(NEW), OLD)).toBe(true);
    expect(prInRepo(pr(OLD), NEW)).toBe(true);
    expect(prConflict(pr(OLD), pr(NEW))).toBe(false);
    expect(prConflict(pr(OLD, 12, "/"), pr(NEW))).toBe(false);
    expect(deliverPrPatch({ id: "T", pr: pr(OLD) }, pr(NEW))).toEqual({}); // 卡上原串原样保留
    expect(prConflict(pr(OLD, 12), pr(NEW, 13))).toBe(true);
    for (const other of ["evil/floka", "floka-ai/floka-fork", "shawnlu96/other"]) {
      expect(prInRepo(pr(other), OLD)).toBe(false);
      expect(prInRepo(pr(other), NEW)).toBe(false);
      expect(prConflict(pr(OLD), pr(other))).toBe(true);
    }
    expect(() => deliverPrPatch({ id: "T", pr: pr(OLD) }, pr("evil/floka"))).toThrow(/PR 已是/);
  });
  test("off / observe 与改前逐字相同（新旧名不认），observe 记一行", () => {
    for (const m of ["off", "observe"] as const) {
      mode(m);
      expect(prInRepo(pr(NEW), OLD)).toBe(false);
      expect(prConflict(pr(OLD), pr(NEW))).toBe(true);
      expect(prInRepo(pr("SHAWNLU96/claudestra"), OLD)).toBe(true); // 改前就不分大小写
      expect(prConflict(pr(OLD), pr(OLD, 12, "/"))).toBe(false);
      expect(lines.map((l) => l.actionKey)).toEqual(m === "observe" ? ["order-deliver-pr.prInRepo", "order-deliver-pr.prConflict"] : []);
    }
  });
});

const policy = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: "/tmp/project" } } }).projects.p;
/** gh 只答 repo view（inspect 的第一步），之后的调用一律报错：拿到 ForeignRepoError 之外的错就说明仓库核验放行了 */
const inspect = async (local: string, prRef: string): Promise<unknown> => {
  const command: typeof runBounded = async (argv) => {
    if (argv[1] === "repo") return { code: 0, stdout: JSON.stringify({ nameWithOwner: local }), stderr: "", timedOut: false };
    return { code: 1, stdout: "", stderr: "passed-repo-check", timedOut: false };
  };
  return mergeExternal(policy, command).inspect(prRef).then(() => null, (e: unknown) => e);
};

describe("[验收线 3] scheduler-merge-external inspect 的仓库核验", () => {
  test("档位 on：卡 PR 旧名、gh repo view 新名不抛 ForeignRepoError；真外仓照旧抛", async () => {
    mode("on");
    const e = await inspect(NEW, pr(OLD));
    expect(isForeignRepoError(e)).toBe(false);
    expect(String((e as Error).message)).toContain("passed-repo-check");
    expect(isForeignRepoError(await inspect(OLD, pr(NEW)))).toBe(false);
    for (const other of ["evil/floka", "floka-ai/floka-fork", "shawnlu96/other"]) {
      expect(isForeignRepoError(await inspect(NEW, pr(other)))).toBe(true);
      expect(isForeignRepoError(await inspect(other, pr(OLD)))).toBe(true);
    }
  });
  test("off / observe：新旧名照旧算外仓", async () => {
    for (const m of ["off", "observe"] as const) {
      mode(m);
      const e = await inspect(NEW, pr(OLD));
      expect(isForeignRepoError(e)).toBe(true);
      expect(e).toMatchObject({ prRepo: OLD, localRepo: NEW });
    }
  });
});

describe("[验收线 4] scheduler-foreign-repo：origin 改成新名后旧卡不误判外仓", () => {
  const cards = [{ pr: pr(OLD), extra: {} }, { pr: null, extra: { repo: OLD } }, { pr: pr("ShawnLu96/Claudestra"), extra: {} }];
  test("档位 on：旧卡不是外仓，真外仓仍是", () => {
    mode("on");
    for (const c of cards) expect(foreignRepoOf(c, NEW)).toBeNull();
    expect(foreignRepoOf({ pr: pr(NEW), extra: {} }, OLD)).toBeNull();
    expect(foreignRepoOf({ pr: pr("evil/floka"), extra: {} }, NEW)).toBe("evil/floka");
    expect(foreignRepoOf({ pr: null, extra: { repo: "floka-ai/floka-fork" } }, NEW)).toBe("floka-ai/floka-fork");
    expect(foreignRepoOf({ pr: pr("shawnlu96/other"), extra: {} }, OLD)).toBe("shawnlu96/other");
  });
  test("off / observe：与改前相同", () => {
    for (const m of ["off", "observe"] as const) {
      mode(m);
      expect(foreignRepoOf(cards[0]!, NEW)).toBe(OLD);
      expect(foreignRepoOf(cards[0]!, OLD)).toBeNull();
      expect(foreignRepoOf({ pr: pr("evil/floka"), extra: {} }, NEW)).toBe("evil/floka");
    }
  });
});

describe("card-repo：多仓去重、剥前缀、找 clone", () => {
  const io = (origins: Record<string, string | null>): RepoDirIO => ({ dirs: () => Object.keys(origins), origin: (d) => origins[d] ?? null, exists: () => true });
  test("档位 on：同一节点新旧名前缀算一个仓库；新名卡剥旧名前缀；旧名 origin 的目录是新名仓库的 clone", () => {
    mode("on");
    expect(repoOfGlobs([`repo:${OLD}/src/a.ts`, `repo:${NEW}/src/b.ts`])).toBe(OLD); // 返回登记的原串
    expect(stripRepoPrefix([`repo:${OLD}/src/a.ts`, `repo:${NEW}/src/b.ts`, "repo:evil/floka/c.ts"], NEW))
      .toEqual(["src/a.ts", "src/b.ts", "repo:evil/floka/c.ts"]);
    expect(repoDirFor("p", NEW, io({ "/x": "evil/floka", "/y": OLD }))).toBe("/y");
    expect(repoDirFor("p", NEW, io({ "/x": "floka-ai/floka-fork", "/z": "shawnlu96/other" }))).toBeNull();
    expect(() => repoOfGlobs([`repo:${NEW}/a`, "repo:evil/floka/b"])).toThrow(/混了 2 个仓库/);
    expect(cardRepoOf({ pr: pr(OLD), extra: {} }, { repo: NEW })).toBe(OLD); // 卡的仓库照原串给出，不改写
  });
  test("off / observe：与改前相同", () => {
    for (const m of ["off", "observe"] as const) {
      mode(m);
      expect(() => repoOfGlobs([`repo:${OLD}/a`, `repo:${NEW}/b`])).toThrow(/混了 2 个仓库/);
      expect(stripRepoPrefix([`repo:${OLD}/a`, `repo:${NEW.toUpperCase()}/b`], NEW)).toEqual([`repo:${OLD}/a`, "b"]);
      expect(repoDirFor("p", NEW, io({ "/y": OLD }))).toBeNull();
    }
  });
});
