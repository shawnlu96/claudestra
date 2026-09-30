/** doctor 的出借 / 借入一行（lend.json，lib/lend-config.ts）：开没开、对谁、上限多少；文件无效时报 fail（此时实际按「关」处理）。 */
import type { Check } from "./doctor.js";
import { LEND_PATH, readLend, type LendEntry } from "./lend-config.js";
import { effectiveLend, readLendContext, type LendContact } from "./lend-policy.js";
import type { ProjectDef } from "./projects.js";

const lendLine = (e: LendEntry): string => {
  const fam = Object.entries(e.families).filter(([, n]) => n! > 0).map(([f, n]) => `${f} ${n}`).join(" / ");
  const confirm = e.confirm === "auto" ? "自动接单" : "逐单确认";
  return `${e.peer}（${fam}，每天 ${e.quota.ordersPerDay} 单，${confirm}${e.until ? `，到 ${e.until.slice(0, 16)}` : ""}）`;
};

export async function checkLend(path = LEND_PATH, ctx?: { contacts: LendContact[]; projects: ProjectDef[] }, now = Date.now()): Promise<Check[]> {
  const base = { group: "Peer", name: "出借 / 借入" };
  const read = await readLend(path);
  if (read.status === "invalid") {
    return [{ ...base, status: "fail", detail: `lend.json 无效，已按「关」处理（不出借、不借入）：${read.error}`,
      fix: `修好或删掉 ${path}，再用 manager lend set / borrow set 重写` }];
  }
  const { contacts, projects } = ctx ?? await readLendContext();
  const eff = effectiveLend(read, contacts, projects, now);
  const lend = eff.lending ? `出借：开，${eff.lend.map(lendLine).join("；")}` : read.file.enabled ? "出借：总开关开，但没有仍有效的条目" : "出借：关";
  const borrow = eff.borrow.length ? `借入：${eff.borrow.map((e) => `${e.peer}（${e.projects.join(",")}，最多 ${e.maxOpen} 单在跑）`).join("；")}` : "借入：无";
  const detail = `${lend}；${borrow}`;
  if (!eff.dropped.length) return [{ ...base, status: "ok", detail }];
  return [{ ...base, status: "warn", detail: `${detail}。已失效：${eff.dropped.join("；")}`, fix: "manager lend status / borrow status 查看；重新 set 或 off 掉失效的条目" }];
}
