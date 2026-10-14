/**
 * 参与者里的审查员 / PM（team-project-TEAMVIS12）：中心正文的 review meta.reviewer、spec meta.pm 是中心按主场报的实例 id
 * 反查出的 `{memberCode, instanceId}`。纯函数，只做类型守卫（web 不 import src）。
 * 审查员取 sourceKey 最大那条 review，PM 取 specRev（sourceKey）最大那条 spec；最新那条没有成员代号就保持原因
 * 「中心暂未同步该角色身份」，不往前找旧的。名字 = 成员代号（夹着长十六进制就不当名字）；机器：实例 = 本机为 local，
 * 否则 other，没有实例为 null；实例 id 只进 instance（title）。单测 tests/web-collab-team-body-roles.test.ts。
 */
import type { TeamBodyReadWire, TeamBodyRecordWire } from "@/lib/api/shared-ledger-team-body";
import type { TeamPerson } from "../collab-detail-model";

/** 同 team-body-model.ts 的 LONG_HEX：可见文字不出现 id */
const LONG_HEX = /[0-9a-f]{16,}/i;
/** 契约的 id 形状（src/lib/shared-ledger-contract-schema.ts id） */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const isId = (v: unknown): v is string => typeof v === "string" && ID.test(v);

interface RoleIdentity { memberCode: string; instanceId: string | null }
/** 有合法成员代号才算有身份；instanceId 有就得是 id 形状，不然整条不认 */
function identityOf(value: unknown): RoleIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isId(v.memberCode) || (v.instanceId !== undefined && !isId(v.instanceId))) return null;
  return { memberCode: v.memberCode, instanceId: v.instanceId ?? null };
}

const keyOf = (r: TeamBodyRecordWire): number => {
  const n = Number(r.sourceKey);
  return Number.isSafeInteger(n) ? n : -1;
};
/** 某类记录里 sourceKey 最大的那条 */
function latest(read: TeamBodyReadWire, kind: "review" | "spec"): TeamBodyRecordWire | null {
  return read.records.filter((r) => r.kind === kind).reduce<TeamBodyRecordWire | null>((best, r) => (!best || keyOf(r) > keyOf(best) ? r : best), null);
}

function personOf(person: TeamPerson, identity: RoleIdentity | null, localInstance: string | null): TeamPerson {
  if (!identity || LONG_HEX.test(identity.memberCode)) return person;
  const instance = identity.instanceId;
  const machine = instance === null ? null : localInstance && instance === localInstance ? "local" : "other";
  return { ...person, name: identity.memberCode, machine, instance, reason: null };
}

/** teamPeople 的结果 + 中心正文 → 审查员 / PM 换成中心同步来的身份（有的话）；执行者不动 */
export function participantsWithRoles(people: readonly TeamPerson[], read: TeamBodyReadWire, localInstance: string | null): TeamPerson[] {
  const reviewer = identityOf(latest(read, "review")?.meta?.reviewer);
  const pm = identityOf(latest(read, "spec")?.meta?.pm);
  return people.map((p) => p.role === "reviewer" ? personOf(p, reviewer, localInstance) : p.role === "pm" ? personOf(p, pm, localInstance) : p);
}
