import { sharedProjectsAnswerPorts } from "./shared-projects-client.js";
import type { Ask } from "../../lib/ledger-asks.js";
import type { SharedProjectsPorts } from "./shared-projects-ports.js";
import { sharedProjectAskPorts } from "./shared-projects-asks.js";
import { answerSharedProject } from "./shared-projects-actions.js";

let ports: SharedProjectsPorts | undefined;
/** Controlled adapter injection; the default route resolves authenticated N2/N3 ports from the original binding. */
export function configureSharedProjects(adapter: (Omit<SharedProjectsPorts, "openAsk" | "getAsk" | "claimAsk" | "recordCompletion" | "completionAsks" | "bindingGeneration">
  & Partial<Pick<SharedProjectsPorts, "openAsk" | "getAsk" | "claimAsk" | "recordCompletion" | "completionAsks" | "bindingGeneration">>) | undefined): void {
  ports = adapter ? { ...sharedProjectAskPorts(), ...adapter } : undefined;
}
export function sharedProjectsPorts(): SharedProjectsPorts | undefined { return ports; }
export async function onSharedProjectAnswered(ask: Ask, inform?: (text: string) => Promise<void>): Promise<void> {
  if (ask.extra.sharedProjectAction !== true) return;
  try {
    const adapter = ports ?? await sharedProjectsAnswerPorts(ask);
    if (adapter) {
      const result = await answerSharedProject(ask, adapter);
      if (Array.isArray(result?.offers) && inform) {
        const accepted = result.offers.filter(offer => offer.accepted === true).length;
        await inform(`对方接收邀请：${accepted}/${result.offers.length}；等待对方本人批准入组。`);
      }
      if (result?.available === true && inform) await inform("团队项目凭据已保存，已通过本机代理读取，项目可用。");
    }
  }
  catch { console.warn("shared project authorization or completion rejected"); } // Fixed wording: an executor error can contain credentials.
}
