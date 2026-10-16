import { readPrincipalsStrictSync } from "../../principals.js";
import type { PrincipalsFile } from "../../principals.js";

interface Click {
  followUp(message: { content: string; ephemeral: boolean }): Promise<unknown>;
}

/** Discord's conversation allowlist also contains external users; only the authenticated owner may grant. */
export async function refusePartClick(id: string, userId: string, click: Click, load: () => PrincipalsFile = readPrincipalsStrictSync): Promise<boolean> {
  if (!id.startsWith("smaint:parts:")) return false;
  let owner = false;
  try {
    const principals = load();
    const p = principals.principals.find(p => p?.id === `discord:${userId}`);
    owner = p?.role === "owner" && !p.disabled && !p.peer;
  } catch (e) {
    console.warn(`[service-maintenance] owner verification failed (${(e as Error).name})`);
  }
  if (owner) return false;
  await click.followUp({ content: "❌ 只有 owner 可以批准 CLI / 服务维护，未签发授权", ephemeral: true });
  return true;
}
