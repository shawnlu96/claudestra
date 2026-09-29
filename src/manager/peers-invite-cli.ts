/**
 * peer-invite-new / peer-invite-redeem / peer-join-auto 的参数解析，从 manager.ts 逐字搬出（manager.ts 没有行数余量，
 * E2E 要加 --allow-legacy 与 --via-relay-page，docs/relay/e2e-design.md §5.1；兑换的 --e2e 在 peer-join.ts parseRedeemArgs）。
 */
import { extractBoolFlag } from "./core.js";
import { cmdPeerInviteNew } from "./peers.js";
import { cmdPeerInviteRedeem, cmdPeerJoinAuto, parseRedeemArgs } from "./peer-join.js";

export async function runPeerInviteCommand(cmd: string, args: string[]): Promise<void> {
  switch (cmd) {
    case "peer-invite-new": {
      const { rest: afterLegacy, value: allowLegacy } = extractBoolFlag(args, "--allow-legacy"); // 明文邀请：对方是老版本才用
      const { rest: afterPage, value: viaRelayPage } = extractBoolFlag(afterLegacy, "--via-relay-page"); // bridge 内部用：经中继的网页生成
      const { rest: afterForce, value: force } = extractBoolFlag(afterPage, "--force");
      let agentsCsv = "", myUrl = "";
      for (let i = 0; i < afterForce.length; i++) {
        const a = afterForce[i];
        if (a === "--agents") agentsCsv = afterForce[++i] || "";
        else if (a.startsWith("--agents=")) agentsCsv = a.slice(9);
        else if (a === "--url") myUrl = afterForce[++i] || "";
        else if (a.startsWith("--url=")) myUrl = a.slice(6);
      }
      await cmdPeerInviteNew(agentsCsv, myUrl, force, allowLegacy || viaRelayPage, viaRelayPage);
      break;
    }
    case "peer-invite-redeem": await cmdPeerInviteRedeem(parseRedeemArgs(args)); break;
    case "peer-join-auto": {
      const { rest: afterForce, value: force } = extractBoolFlag(args, "--force");
      let agentsCsv = "", myUrl = "", peerUrl = "";
      const pos: string[] = [];
      for (let i = 0; i < afterForce.length; i++) {
        const a = afterForce[i];
        if (a === "--agents") agentsCsv = afterForce[++i] || "";
        else if (a.startsWith("--agents=")) agentsCsv = a.slice(9);
        else if (a === "--url") myUrl = afterForce[++i] || "";
        else if (a.startsWith("--url=")) myUrl = a.slice(6);
        // v2.16.1: 覆盖邀请串里的对方地址(跨 tailnet 共享下串里嵌的是发方
        // 视角 IP,接方视角是另一个映射地址——2026-07-31 实战踩坑)
        else if (a === "--peer-url") peerUrl = afterForce[++i] || "";
        else if (a.startsWith("--peer-url=")) peerUrl = a.slice(11);
        else pos.push(a);
      }
      await cmdPeerJoinAuto(pos[0] || "", agentsCsv, myUrl, force, peerUrl);
      break;
    }
  }
}
