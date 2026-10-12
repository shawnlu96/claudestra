/** Progress is reported separately from the final recovered notice, without treating uncertainty as success. */
import type { Wall, WallRecovery } from "./quota-wall.js";
import { resumeSettled } from "./quota-resume-state.js";

function progressNotice(w: Wall): { key: string; text: string } | null {
  const pending: string[] = [], uncertain: string[] = [], review: string[] = [], states: string[][] = [];
  for (const [cid, hit] of Object.entries(w.hits).sort(([a], [b]) => a.localeCompare(b))) {
    const p = w.resumeStates?.[cid];
    if (!p || resumeSettled(p)) continue;
    const name = `${hit.agent}（${cid}）`;
    // The key tracks targets and status only: a reason flapping between not_delivered and a failed read is not progress.
    states.push([cid, p.status === "sending" ? "unknown" : p.status]);
    if (p.status === "unknown" || p.status === "sending") uncertain.push(name);
    else if (!hit.identity || p.reason !== "not_delivered") review.push(name);
    else pending.push(name);
  }
  if (!pending.length && !uncertain.length && !review.length) return null;
  const text = ["⚠️ 额度闸已出闸，续跑尚未结清。",
    pending.length ? `明确未送达：${pending.join("、")}；按退避重试，离线连接恢复后再试。` : "",
    uncertain.length ? `可能已送达：${uncertain.join("、")}；不自动重投，需核实原会话。` : "",
    review.length ? `身份待核：${review.join("、")}；身份或回合状态未获确认，不盲投。` : "",
  ].filter(Boolean).join("\n");
  return { key: JSON.stringify(states), text };
}

/** Failed owner notices also back off; successful notices keep the same minimum interval and deduplicate after restart until targets or statuses change. */
export async function notifyQuotaResumeProgress(w: Wall, d: { now(): number; notifyOwner(text: string): Promise<boolean>; log(msg: string): void },
  save: (patch: Partial<WallRecovery>) => boolean): Promise<void> {
  const notice = progressNotice(w), r = w.recovery;
  if (!notice || !r || r.progressNoticeKey === notice.key || (r.progressNoticeNextAt ?? 0) > d.now()) return;
  if (!save({ progressNoticeNextAt: d.now() + 300_000 })) return;
  try {
    if (await d.notifyOwner(notice.text)) save({ progressNoticeKey: notice.key });
  } catch (e) {
    d.log(`额度恢复待核通知失败，退避后重试：${(e as Error).message}`);
  }
}
