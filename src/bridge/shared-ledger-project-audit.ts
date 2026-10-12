import { bindHash, checkAsk } from "../lib/ask-bind.js";
import { MASTER_PROJECT, ownerAnswered, type Ask, type AskBind } from "../lib/ledger-asks.js";
import {
  applyProjectAuditChoice, auditSharedLedgerProjects, auditTargetKey, auditVersion,
  type ProjectAudit, type ProjectAuditMutationPorts,
} from "../lib/shared-ledger-project-audit.js";
import type { CreateAskInput } from "./asks.js";

const CREATOR = "system:shared-ledger-project-audit";
const SKIP = "sl_audit_skip";
const TTL = 24 * 3600_000;
export interface ProjectAuditPorts extends ProjectAuditMutationPorts {
  now: () => number;
  asks: () => Ask[];
  openAsk: (input: CreateAskInput) => Ask;
  closeAsk: (id: string, state: "cancelled" | "expired") => void;
  /** Atomically mark the persisted answered card consumed before performing any side effect. */
  claim: (id: string) => boolean;
  inform: (text: string) => Promise<void>;
}
const bindOf = (audit: ProjectAudit): Omit<AskBind, "paramsHash"> => ({
  action: "shared_ledger_project_audit", params: audit, version: audit.version, approve: audit.choices.map(c => c.button),
});
const snapshot = (a: Ask): ProjectAudit | undefined => a.extra.projectAudit as ProjectAudit | undefined;
// Rows alone cannot detect lost credentials, personal projects or a changed N4 choice model.
const issueKey = (a: ProjectAudit): string => bindHash(bindOf(a), CREATOR);

function card(audit: ProjectAudit, previous: Ask[], now: number): CreateAskInput {
  const bind = bindOf(audit);
  // The ledger deduplicates closed cards too; a successor must have a distinct, deterministic generation key.
  const generation = previous.map(a => a.id).sort().join(",");
  const suffix = bindHash({ action: "audit_generation", params: generation }, CREATOR);
  const labels = { normal: "正常", dangling: "原本机项目不存在", duplicate: "有多个绑定", personal: "原绑定为个人项目",
    unbound: "已有凭据但尚未绑定", "credential-missing": "缺少本人读取凭据" };
  return {
    source: "system", createdBy: CREATOR, project: MASTER_PROJECT, kind: "authorize", title: "共享项目核对",
    context: `团队 ${audit.target.teamId} / ${audit.target.name}：${labels[audit.status]}。请选择本机项目；点确认后才改绑。`,
    options: [{ type: "buttons", buttons: [...audit.choices.map(c => ({ id: c.button,
      label: `${c.kind === "create" ? "新建" : "确认绑定到"} ${c.name.slice(0, 48)}${c.button === audit.selected ? "（推荐）" : ""}`, style: "success" })),
    { id: SKIP, label: "暂不处理", style: "secondary" }] }],
    allowText: false, blocking: false, expiresAt: now + TTL,
    dedupKey: `sl-project-audit:${issueKey(audit)}:${suffix}`, bind: { ...bind, paramsHash: bindHash(bind, CREATOR) },
    extra: { projectAudit: structuredClone(audit) },
  };
}

/** Serialized per bridge; persistent claims and N2 CAS additionally protect restart and multi-process races. */
export class SharedLedgerProjectAuditor {
  private tail: Promise<void> = Promise.resolve();
  private offered = new Set<string>();
  constructor(private ports: ProjectAuditPorts) {}

  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => { /* Caller receives the failure; keep later audit work runnable. */ });
    return result;
  }

  /** Called at startup and after successful join; never changes bindings by itself. */
  run(): Promise<void> {
    return this.enqueue(async () => {
      for (const a of this.ports.asks()) await this.answer(a);
      await this.scan();
    });
  }

  onAnswered(a: Ask): Promise<void> { return this.enqueue(() => this.answer(a)); }

  private async scan(): Promise<void> {
    const d = this.ports, audits = auditSharedLedgerProjects(await d.read(), d.projectChoices);
    const latest = new Map(audits.map(a => [auditTargetKey(a.target), a]));
    for (const a of d.asks().filter(a => a.createdBy === CREATOR && snapshot(a))) {
      const old = snapshot(a)!, current = latest.get(auditTargetKey(old.target));
      const changed = !current || current.status === "normal" || issueKey(current) !== issueKey(old);
      if (changed) this.offered.delete(issueKey(old));
      if (a.state !== "open") continue;
      if (changed) d.closeAsk(a.id, "cancelled");
      else if (a.expiresAt <= d.now()) {
        d.closeAsk(a.id, "expired");
        // Only cards offered in this process stay quiet; a restarted controller reoffers expired persisted cards.
      }
    }
    for (const audit of audits) {
      const previous = d.asks().filter(a => a.createdBy === CREATOR && snapshot(a)
        && auditTargetKey(snapshot(a)!.target) === auditTargetKey(audit.target));
      if (audit.status === "normal") continue;
      const key = issueKey(audit);
      const existing = previous.find(a => a.state === "open" && a.expiresAt > d.now() && issueKey(snapshot(a)!) === key);
      if (existing || this.offered.has(key)) { this.offered.add(key); continue; }
      d.openAsk(card(audit, previous, d.now()));
      this.offered.add(key);
    }
  }

  private async answer(a: Ask): Promise<void> {
    const d = this.ports;
    if (a.createdBy !== CREATOR || a.state !== "answered" || a.extra.projectAuditSettled) return;
    const audit = snapshot(a);
    if (!audit || !d.claim(a.id)) return;
    this.offered.add(issueKey(audit));
    const picks = a.answer?.choices ?? [];
    if (picks.length === 1 && picks[0] === `[button:${SKIP}]`) return;
    const choice = audit.choices.find(c => picks[0] === `[button:${c.button}]`);
    if (picks.length !== 1 || !choice || !ownerAnswered(a.answer) || auditVersion(audit.expected) !== audit.version
      || !checkAsk({ ...a, fromAgent: CREATOR }, bindHash(bindOf(audit), CREATOR), CREATOR, d.now()).ok) {
      await d.inform("共享项目未改绑：授权无效或已过期，下次启动会重新核对。");
      return;
    }
    try {
      await applyProjectAuditChoice(audit, choice, d);
    } catch {
      // Neither center responses nor filesystem errors may leak credentials/paths through a card.
      this.offered.delete(issueKey(audit));
      await this.scan();
      await d.inform("共享项目未确认改绑：状态可能已变化，请查看最新核对卡。");
      return;
    }
    await d.inform(`共享项目 ${audit.target.name} 已绑定，可在本机项目下查看「团队 · 全部 feature」。`);
  }
}
