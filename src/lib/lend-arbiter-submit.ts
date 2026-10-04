/** Arbitrators use the ordinary caller witness and journal CAS, but their conclusions cannot become ordinary review verdicts. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { advance, getOrder, JournalConflict, type LendRow } from "./lend-journal.js";
import type { SubmitInput, SubmitOutcome } from "./lend-submit.js";
import { parseLendRequest } from "./lend-wire.js";
import type { OrderWire } from "./order-wire.js";
import { resolveBunPath } from "./bun-path.js";
import { SRC_DIR } from "./repo-root.js";
import { shellEscape } from "./claude-launch.js";
import { RUNTIME_DIR, STATE_DIR } from "./paths.js";
import { BUN_NO_AUTOLOAD } from "./runtimes/clean-env.js";

export function arbiterSubmit(db: Database, row: LendRow, input: SubmitInput, now: number): SubmitOutcome | null {
  const order = row.wire?.order as unknown as OrderWire | undefined;
  if (order?.convergence?.kind !== "arbitration") return null;
  if ((input.verdict !== "upheld" && input.verdict !== "overturned") || !row.sessionId || !row.leaseGen) {
    return { ok: false, error: "arbitration requires upheld/overturned and its bound session" };
  }
  const payload = { v: 1, orderId: row.orderId, gen: row.leaseGen, report: input.report, session: { id: row.sessionId, family: row.family },
    arbitration: { verdict: input.verdict, head: order.head, specRev: order.specRev, round: order.round },
    verdict: { v: 1, orderId: row.orderId, head: order.head, verdict: input.verdict === "upheld" ? "changes" : "pass",
      p0: 0, p1: 0, p2: 0, findings: [], reportPath: "report.md" } };
  const parsed = parseLendRequest("result", payload);
  if (!parsed.ok || Buffer.byteLength(JSON.stringify(payload)) > 96 * 1024) return { ok: false, error: parsed.ok ? "arbitration report too large" : parsed.error };
  const sha = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  if (row.state === "started") {
    try {
      advance(db, row.orderId, "started", "result_pending", { payload, payloadSha: sha }, now);
      return { ok: true, duplicate: false, sha };
    } catch (e) {
      if (!(e instanceof JournalConflict)) throw e;
      row = getOrder(db, row.orderId)!;
    }
  }
  return row?.state === "result_pending" && row.payloadSha === sha ? { ok: true, duplicate: true, sha }
    : { ok: false, error: "arbitration already has a different conclusion or is cancelled" };
}

/**
 * worker 的交付命令。worker 本体的状态 / 运行目录是专属空目录（runtimes/clean-env.ts workerPrivateDirs），而交付要读写生产的 journal /
 * registry、核 tmux 窗口，所以只在这一条命令里显式带上生产目录；去掉它们，交付会报「本机没有出借 journal」。
 */
export const lendSubmitCmd = (orderId: string): string =>
  `env CLAUDESTRA_STATE_DIR=${shellEscape(STATE_DIR)} CLAUDESTRA_RUNTIME_DIR=${shellEscape(RUNTIME_DIR)} ${resolveBunPath()} ${BUN_NO_AUTOLOAD.join(" ")} ` +
  `${SRC_DIR}/manager.ts lend submit ${orderId}`;

export function arbiterFooter(row: LendRow, ordinary: () => string): string {
  return (row.wire?.order as unknown as OrderWire | undefined)?.convergence?.kind === "arbitration"
    ? `独立新会话仲裁，只读，不提交。报告写当前clone普通文件。回写：${lendSubmitCmd(row.orderId)}` +
      " --verdict upheld|overturned --report report.md（只裁单上finding，不用submit_verdict）" : ordinary();
}

export const arbitrateFlags = (f: Record<string, string | undefined>): void => {
  if ((f.verdict === "upheld" || f.verdict === "overturned") && f.findings === undefined && f["findings-file"] === undefined) f.findings = "[]";
};

export const arbiterFullMessage = (row: LendRow): boolean => (row.wire?.order as unknown as OrderWire | undefined)?.convergence?.kind === "arbitration";
