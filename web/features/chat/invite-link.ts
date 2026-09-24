/**
 * 一键邀请的链接与「发给对方的一段话」（纯函数，tests/web-invite-link.test.ts）。
 * 邀请码 = base64url 的 JSON {v:2,name,url,token,join,iid?}（src/lib/peers.ts encodePeerInviteV2）。
 * 链接 = 邀请方地址 + /api/v1/invite#邀请码：打开的是邀请方机器上的落地页（src/bridge/invite-page.ts），
 * 邀请码在 # 后面，不进任何服务器日志。这里只解出展示用的 name / url；完整校验在服务端（peer-invite-inspect）。
 */

/** 能认出邀请码的一段：base64url 的 {"v":2, 开头固定是 eyJ2IjoyL */
const CODE_RE = /eyJ2IjoyL[A-Za-z0-9_-]{40,}/;

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 解出展示信息；不是 v2 邀请返回 null */
export function decodeInvite(code: string): { name: string; url: string } | null {
  try {
    const j = JSON.parse(b64urlDecode(code.trim())) as { v?: unknown; name?: unknown; url?: unknown };
    if (j.v !== 2 || typeof j.name !== "string" || !j.name || typeof j.url !== "string" || !/^https?:\/\//.test(j.url)) return null;
    return { name: j.name, url: j.url.replace(/\/+$/, "") };
  } catch {
    return null; // 不是 base64 / 不是 JSON：就不是邀请码
  }
}

/** 从任意一段文字（粘贴的整段话、链接、裸邀请码）里找出邀请码 */
export function findInviteCode(text: string): string | null {
  const m = CODE_RE.exec(text);
  return m && decodeInvite(m[0]) ? m[0] : null;
}

export function inviteLink(code: string): string | null {
  const inv = decodeInvite(code);
  return inv ? `${inv.url}/api/v1/invite#${code}` : null;
}

/** 复制给对方的一整段话：谁邀请、能找谁、怎么加入（链接打不开时的退路也写上） */
export function inviteMessage(code: string, agents: string[], lang: "zh" | "en" = "zh"): string | null {
  const inv = decodeInvite(code);
  const link = inviteLink(code);
  if (!inv || !link) return null;
  const list = agents.join(", ");
  return lang === "en"
    ? `${inv.name} invites your Claudestra to collaborate${list ? ` (you'll be able to reach: ${list})` : ""}. ` +
        `Open this link and confirm in your own Claudestra:\n${link}\n\n` +
        `If the link doesn't open, paste this whole message under Peer → Join in your Claudestra. Valid for 24h, single use.`
    : `${inv.name} 邀请你的 Claudestra 一起协作${list ? `（加入后你可以找：${list}）` : ""}。` +
        `点开这个链接，按提示在你自己的 Claudestra 里确认就行：\n${link}\n\n` +
        `链接打不开的话，把这整段话粘贴到你的 Claudestra → Peer → 加入。24 小时内有效，只能用一次。`;
}
