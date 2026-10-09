/** Per-ticker incidents; retry only on completed failed rounds, never create another timer. */
import { auditFailureText, type AuditFailureKind, type AuditFailureTarget } from "../lib/ledger-audit-failure.js";
import { newMessageId, newThreadId } from "./router.js";

export interface AuditNoticeIdentity { messageId: string; threadId: string; ts: string }
export type AuditNoticeReceipt = { kind: "sent" } | { kind: "queued"; messageId: string } | { kind: "failed" };
interface Notice { identity: AuditNoticeIdentity; content: string; attempts: number; next: number; receipt?: AuditNoticeReceipt }
interface FailurePorts {
  targets(): AuditFailureTarget[];
  notify(to: string, content: string, identity: AuditNoticeIdentity): Promise<AuditNoticeReceipt>;
}

export function ledgerAuditFailures(ports: FailurePorts) {
  let rounds = 0, nextLookup = 3, lookupAttempts = 0;
  const notices = new Map<string, Notice>();
  let diagnostic = false;
  const diagnose = (e: unknown) => {
    if (!diagnostic) console.error("⚠️ 台账巡检失败告警尚未登记，后续失败轮重试:", e);
    diagnostic = true;
  };
  // One attempt per eligible round; delay caps at 8 existing ticker intervals.
  const retryDelay = (attempts: number) => 2 ** Math.min(attempts - 1, 3);
  return {
    ok(): void {
      rounds = 0; nextLookup = 3; lookupAttempts = 0; diagnostic = false; notices.clear();
    },
    async fail(kind: AuditFailureKind): Promise<void> {
      rounds++;
      if (rounds < nextLookup) return;
      let targets: AuditFailureTarget[];
      try {
        targets = ports.targets();
        if (!targets.length) throw new Error("台账巡检失败告警没有可核验的项目 PM");
        lookupAttempts = 0;
      } catch (e) {
        nextLookup = rounds + retryDelay(++lookupAttempts);
        diagnose(e);
        return;
      }
      for (const { project, to } of targets) {
        let notice = notices.get(project);
        if (!notice) {
          notice = { identity: { messageId: newMessageId("audit-failure"), threadId: newThreadId(), ts: new Date().toISOString() },
            content: auditFailureText(project, kind), attempts: 0, next: rounds };
          notices.set(project, notice);
        }
        if (notice.receipt || rounds < notice.next) continue;
        notice.next = rounds + retryDelay(++notice.attempts);
        try {
          const receipt = await ports.notify(to, notice.content, notice.identity);
          if (receipt.kind === "failed") diagnose(new Error(`台账巡检 ${project} 告警投递未接受`));
          else notice.receipt = receipt; // queued retains this message ID; it is not a read receipt.
        } catch (e) { diagnose(e); }
      }
    },
  };
}
