/**
 * E2E 帧在两道闸上开的口子（断言全在 tests/peer-e2e-gates-fixture.ts）。fixture 在 crypto.subtle 上装 spy、往 api-auth 的进程全局失败桶里记数，
 * 还要生成多组身份：同进程跑在邻居旁边会互相污染，所以整套只在私有 HOME/状态/运行/临时目录的子进程里跑，这里核子进程的精确计数与回执。
 */
import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPub } from "../src/lib/e2e/primitives.ts";
import { RUNTIME_DIR, STATE_DIR } from "../src/lib/paths.ts";
import { testChildEnv } from "./test-env.ts";

const role = process.env.CLAUDESTRA_E2E_GATES_ROLE;
const FIXTURE_TESTS = 10;
type Receipt = { state: string; runtime: string; tmp: string; fps: string[]; dirs: string[]; cleaned: boolean; restored: boolean };
type Run = { code: number | null; out: string; err: string; root: string; state: string; runtime: string };

/** testChildEnv 只带 PATH/测试标记/死端口 bridge；HOME、状态、运行、临时目录全换成本次私有的 */
async function spawnGates(childRole: "suite" | "observer", sabotage = ""): Promise<Run> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "e2e-gates-run-")));
  const dirs = Object.fromEntries(["home", "state", "runtime", "tmp"].map((name) => [name, join(root, name)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  const child = Bun.spawn([process.execPath, "--no-env-file", "test", import.meta.path], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    env: testChildEnv({ HOME: dirs.home, CLAUDESTRA_STATE_DIR: dirs.state, CLAUDESTRA_RUNTIME_DIR: dirs.runtime,
      TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp, CLAUDESTRA_E2E_GATES_ROLE: childRole, CLAUDESTRA_E2E_GATES_SABOTAGE: sabotage || undefined }),
  });
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out, err, root, state: dirs.state, runtime: dirs.runtime };
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 子进程实际用的目录归本次私有根：就是给它的那个，或是 test-guard 换成的——子进程 preload 把 tmpdir 再下钻一层
 * cstra-test-run-*，TMPDIR 不在 /tmp、/var/folders 下时（工作区里的私有临时目录），兄弟目录 state/runtime 就不算临时目录，
 * 被换到子进程自己的 tmpdir 下。这时只认落在子进程 tmpdir 里、且该 tmpdir 在本次私有根里的
 */
function ownedBy(run: Run, receipt: Receipt, actual: string, given: string): boolean {
  const under = (p: string, dir: string) => p.startsWith(`${dir}/`);
  return under(receipt.tmp, run.root) && (actual === given || under(actual, receipt.tmp));
}

/** 父入口的判据：退出码 0、精确的 pass 数、0 fail、恰好一行回执且状态/运行目录归本次私有根 */
function judge(run: Run, pass: number, tag: string): Receipt {
  const log = run.out + run.err;
  if (run.code !== 0) throw new Error(`子进程退出码 ${run.code}\n${log.slice(-8000)}`);
  if (!new RegExp(`(^|\\n) ${pass} pass\\n 0 fail\\n`).test(run.err)) throw new Error(`子进程计数不是 ${pass} pass / 0 fail\n${log.slice(-8000)}`);
  const reports = run.out.split("\n").filter((line) => line.startsWith(`${tag} `));
  if (reports.length !== 1) throw new Error(`子进程回执 ${reports.length} 行\n${log.slice(-8000)}`);
  const receipt = JSON.parse(reports[0]!.slice(tag.length + 1)) as Receipt;
  if (!ownedBy(run, receipt, receipt.state, run.state)) throw new Error(`回执的状态目录 ${receipt.state} 不归本次私有根 ${run.root}`);
  if (!ownedBy(run, receipt, receipt.runtime, run.runtime)) throw new Error(`回执的运行目录 ${receipt.runtime} 不归本次私有根 ${run.root}`);
  return receipt;
}
const runSuite = async (sabotage = "") => judge(await spawnGates("suite", sabotage), FIXTURE_TESTS, "E2E_GATES_RESULT");

if (role === "suite") {
  await import("./peer-e2e-gates-fixture.ts");
} else if (role === "observer") {
  test("并行两组完整断言：身份、状态、临时目录各自私有并清理；同进程邻居的 deriveBits spy 与状态文件不被覆写", async () => {
    const sentinel = JSON.stringify({ httpPeers: [], pendingInvites: [], sentinel: "neighbor" });
    writeFileSync(join(STATE_DIR, "peers.json"), sentinel);
    const neighbor = spyOn(crypto.subtle, "deriveBits");
    // 旧红的实际成因：同进程邻居（e2e-machine-key.test.ts）导入不在曲线上的点后，Bun 1.3.10 的 BoringSSL 错误队列没清，
    // 下一次 createPrivateKey 抛 POINT_IS_NOT_ON_CURVE → 身份生成为 null → 依赖身份的 7 条全红。父进程照做一遍，子进程不受影响
    expect(await importPub(new Uint8Array(65).fill(4))).toBeNull();
    try {
      // allSettled：一组失败时也等另一组退出，免得它在私有目录被删后还在跑
      const results = await Promise.allSettled([runSuite(), runSuite()]);
      const receipts = results.map((r) => {
        if (r.status === "rejected") throw r.reason;
        return r.value;
      });
      for (const r of receipts) {
        expect(r.fps.length).toBe(4);
        expect(new Set(r.fps).size).toBe(4);
        expect(r.dirs.every((d) => d.startsWith(r.tmp))).toBe(true);
        expect(r).toMatchObject({ cleaned: true, restored: true });
        for (const d of r.dirs) expect(existsSync(d)).toBe(false);
      }
      expect(receipts[0]!.state).not.toBe(receipts[1]!.state);
      expect(receipts[0]!.fps.filter((fp) => receipts[1]!.fps.includes(fp))).toEqual([]);
      expect(readFileSync(join(STATE_DIR, "peers.json"), "utf8")).toBe(sentinel);
      expect(crypto.subtle.deriveBits).toBe(neighbor as never);
      expect(neighbor.mock.calls.length).toBe(0); // 子进程里的 ECDH 一次也没记到邻居的 spy 上
      process.stdout.write("E2E_GATES_OBSERVER " + JSON.stringify({ state: STATE_DIR, runtime: RUNTIME_DIR, tmp: tmpdir() }) + "\n");
    } finally {
      neighbor.mockRestore();
    }
  });
} else {
  test("peer-e2e-gates 原入口：私有子进程里两组并行跑完全部旧断言，邻居探针确认隔离与清理", async () => {
    judge(await spawnGates("observer"), 1, "E2E_GATES_OBSERVER");
  });

  test("误配探针：子进程里故意错一条断言、或中途退出，父入口都判红", async () => {
    const [wrong, exited] = await Promise.all([spawnGates("suite", "assert"), spawnGates("suite", "exit")]);
    expect(() => judge(wrong, FIXTURE_TESTS, "E2E_GATES_RESULT")).toThrow("退出码 1");
    expect(wrong.err).toMatch(/\n 10 pass\n 1 fail\n/);
    expect(() => judge(exited, FIXTURE_TESTS, "E2E_GATES_RESULT")).toThrow("退出码 3");
  });

  test("回执目录探针：给的目录或子进程 tmpdir 里换的目录才算本次私有，私有根外的判红", () => {
    const root = "/r/e2e-gates-run-x", tmp = `${root}/tmp/cstra-test-run-1-y`;
    const run = (receipt: Partial<Receipt>): Run => ({ code: 0, err: " 1 pass\n 0 fail\n", root, state: `${root}/state`, runtime: `${root}/runtime`,
      out: "T " + JSON.stringify({ state: `${root}/state`, runtime: `${root}/runtime`, tmp, ...receipt }) + "\n" });
    expect(judge(run({}), 1, "T").state).toBe(`${root}/state`);
    expect(judge(run({ state: `${tmp}/cstra-test-state-z`, runtime: `${tmp}/cstra-test-rt-z` }), 1, "T").tmp).toBe(tmp);
    expect(() => judge(run({ state: "/tmp/cstra-test-state-z" }), 1, "T")).toThrow("状态目录");
    expect(() => judge(run({ runtime: "/tmp/claude-orchestrator" }), 1, "T")).toThrow("运行目录");
    expect(() => judge(run({ state: `${root}/tmp/cstra-test-state-z` }), 1, "T")).toThrow("状态目录"); // 根内但不在子进程 tmpdir
    expect(() => judge(run({ tmp: "/tmp/elsewhere" }), 1, "T")).toThrow("状态目录");
  });
}
