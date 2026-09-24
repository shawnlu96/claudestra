/**
 * peer-invite-inspect '<邀请串>'：加入之前先看一眼（只读，不兑换、不写任何文件）。
 * 用邀请里预签的 token GET 对方 /api/v1/agents：通 = 顺带拿到「加入后能找哪些 agent」；
 * 不通就给出和加入失败同一套的原因与下一步（lib/peer-join-hints.ts）。网页的加入确认卡用它，
 * 让人在点「加入」之前就知道能不能成，而不是点了才看到一句 timed out。
 */
import { output } from "./core.js";
import { classifyJoinError, joinFailureHint, localTailnetAddr, type JoinFailureKind } from "../lib/peer-join-hints.js";

export async function cmdPeerInviteInspect(inviteStr: string) {
  const { parsePeerInviteV2, readPeers, isSameInviter } = await import("../lib/peers.js");
  const hs = parsePeerInviteV2(inviteStr || "");
  if (!hs) {
    output({ ok: false, error: "邀请码不完整或不是一键邀请（请让对方重新复制整段发你）" });
    return;
  }
  // 已经连着这个对方了：加入会刷新那条记录的地址 / token，确认卡上提一句
  const existing = (await readPeers()).httpPeers?.find((p) => isSameInviter(p, hs))?.name;
  const base = { ok: true, name: hs.name, url: hs.url, ...(existing ? { existing } : {}) };
  let failKind: JoinFailureKind = "other";
  try {
    const r = await fetch(`${hs.url}/api/v1/agents`, { headers: { Authorization: `Bearer ${hs.token}` }, signal: AbortSignal.timeout(6000) });
    const body = (await r.json().catch(() => null)) as { agents?: { name?: string }[] } | null; // 不是 JSON = 地址那头不是 bridge
    if (r.ok) {
      const agents = (body?.agents ?? []).map((a) => String(a?.name ?? "").replace(/^agent-/, "")).filter(Boolean);
      output({ ...base, reachable: true, agents });
      return;
    }
    failKind = r.status === 401 || r.status === 403 ? "rejected" : "other";
  } catch (e) {
    failKind = classifyJoinError(e as Error & { code?: unknown });
  }
  const net = failKind === "timeout" || failKind === "refused";
  output({
    ...base, reachable: false, failKind,
    hint: joinFailureHint(failKind, { peerUrl: hs.url, myAddr: net ? await localTailnetAddr() : undefined }),
  });
}
