/**
 * peer-invite-new / peer-invite-redeem / peer-join-auto 的参数解析，从 manager.ts 搬出（manager.ts 没有行数余量，
 * E2E 要加 --allow-legacy 与 --via-relay-page，docs/relay/e2e-design.md §5.1；兑换的 --e2e 在 peer-join.ts parseRedeemArgs）。
 * `--x v` / `--x=v` 统一走 core.ts 的 extractStringFlag（后出现的覆盖先出现的、缺值当空串），别再手写循环。
 */
import { extractBoolFlag, extractStringFlag } from "./core.js";
import { cmdPeerInviteNew } from "./peers.js";
import { cmdPeerInviteRedeem, cmdPeerJoinAuto, parseRedeemArgs } from "./peer-join.js";

/** 依次抽出这几个取值参数，剩下的是位置参数 */
function stringFlags(args: string[], names: readonly string[]): { values: Record<string, string>; pos: string[] } {
  const values: Record<string, string> = {};
  let rest = args;
  for (const n of names) {
    const r = extractStringFlag(rest, `--${n}`);
    values[n] = r.value ?? "";
    rest = r.rest;
  }
  return { values, pos: rest };
}

export async function runPeerInviteCommand(cmd: string, args: string[]): Promise<void> {
  switch (cmd) {
    case "peer-invite-new": {
      const { rest: afterLegacy, value: allowLegacy } = extractBoolFlag(args, "--allow-legacy"); // 明文邀请：对方是老版本才用
      const { rest: afterPage, value: viaRelayPage } = extractBoolFlag(afterLegacy, "--via-relay-page"); // bridge 内部用：经中继的网页生成
      const { rest: afterForce, value: force } = extractBoolFlag(afterPage, "--force");
      const { values: v } = stringFlags(afterForce, ["agents", "url"]);
      await cmdPeerInviteNew(v.agents, v.url, force, allowLegacy || viaRelayPage, viaRelayPage);
      break;
    }
    case "peer-invite-redeem": await cmdPeerInviteRedeem(parseRedeemArgs(args)); break;
    case "peer-join-auto": {
      const { rest: afterForce, value: force } = extractBoolFlag(args, "--force");
      // --peer-url 覆盖邀请串里的对方地址：跨 tailnet 共享时串里嵌的是发方视角的 IP，接方要换成自己视角的映射地址
      const { values: v, pos } = stringFlags(afterForce, ["agents", "url", "peer-url"]);
      await cmdPeerJoinAuto(pos[0] || "", v.agents, v.url, force, v["peer-url"]);
      break;
    }
  }
}
