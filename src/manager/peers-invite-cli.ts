/**
 * peer-invite-new / peer-invite-redeem / peer-join-auto 的参数解析，从 manager.ts 逐字搬出（manager.ts 没有行数余量，
 * E2E 要加 --allow-legacy 与 --e2e，docs/relay/e2e-design.md §5.1）。
 */
import { extractBoolFlag } from "./core.js";
import { cmdPeerInviteNew, cmdPeerInviteRedeem } from "./peers.js";
import { cmdPeerJoinAuto } from "./peers-join.js";

export async function runPeerInviteCommand(cmd: string, args: string[]): Promise<void> {
  switch (cmd) {
    case "peer-invite-new": {
      const { rest: afterLegacy, value: allowLegacy } = extractBoolFlag(args, "--allow-legacy"); // 明文邀请：对方是老版本才用
      const { rest: afterForce, value: force } = extractBoolFlag(afterLegacy, "--force");
      let agentsCsv = "", myUrl = "";
      for (let i = 0; i < afterForce.length; i++) {
        const a = afterForce[i];
        if (a === "--agents") agentsCsv = afterForce[++i] || "";
        else if (a.startsWith("--agents=")) agentsCsv = a.slice(9);
        else if (a === "--url") myUrl = afterForce[++i] || "";
        else if (a.startsWith("--url=")) myUrl = a.slice(6);
      }
      await cmdPeerInviteNew(agentsCsv, myUrl, force, allowLegacy);
      break;
    }
    case "peer-invite-redeem": {
      let join = "", name = "", url = "", token = "", iid = "", fp = "", e2e = "";
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--join") join = args[++i] || "";
        else if (a === "--name") name = args[++i] || "";
        else if (a === "--url") url = args[++i] || "";
        else if (a === "--token") token = args[++i] || "";
        else if (a === "--iid") iid = args[++i] || "";
        else if (a === "--fp") fp = args[++i] || ""; // 经中继兑换时 bridge 带上的对方指纹
        else if (a === "--e2e") e2e = args[++i] || ""; // 加密兑换：bridge 验过签的对方 {idk, ek}（bridge/peer-redeem-route.ts）
      }
      await cmdPeerInviteRedeem(join, name, url, token, iid, fp, e2e);
      break;
    }
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
