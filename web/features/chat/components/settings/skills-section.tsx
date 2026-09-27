"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { skillLibrary } from "@/lib/api/system";
import {
  homeOf,
  RUNTIME_LABEL,
  runtimeCounts,
  SCOPE_LABEL,
  shortPath,
  visibleSkills,
  type LibrarySkill,
  type RuntimeFilter,
  type SkillLibrary,
  type SkillRoot,
} from "../../skills-library-logic";

/**
 * 设置 ·「技能」页：这台电脑上各 runtime 能用的技能、从哪来、同名时谁生效（只读）。
 * 启用 / 停用、安装以它为底（台账 i03 第一期）；数据与规则见 src/lib/skill-library.ts。
 */
export function SkillsSection() {
  const t = useT();
  const [lib, setLib] = useState<SkillLibrary | null>(null);
  const [err, setErr] = useState("");
  const [rt, setRt] = useState<RuntimeFilter>("all");
  const [q, setQ] = useState("");
  useEffect(() => {
    let alive = true;
    skillLibrary<SkillLibrary>()
      .then((v) => alive && setLib(v))
      .catch((e: Error) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, []);
  const home = lib ? homeOf(lib.roots) : null;
  const list = lib ? visibleSkills(lib.skills, rt, q) : [];
  return (
    <>
      <section className="rounded-xl bg-base-200/60 p-4">
        <div className="text-[13.5px] font-semibold">{t("这台电脑上的技能")}</div>
        <p className="mt-0.5 text-xs leading-relaxed text-base-content/50">
          {t("各 runtime 能用哪些技能、从哪来、同名时谁生效。现在只能看，启用 / 停用和安装后面做。")}
        </p>
        {err && <div className="mt-2 text-xs text-error">{t("读取失败")}: {err}</div>}
        {!lib && !err && <span className="loading loading-spinner loading-xs mt-3" />}
        {lib && (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {runtimeCounts(lib.skills).map((c) => (
                <button
                  key={c.id}
                  className={`btn btn-xs rounded-full font-normal ${rt === c.id ? "btn-primary" : "btn-ghost bg-base-100/70"}`}
                  onClick={() => setRt(c.id)}
                >
                  {c.id === "all" ? t("全部") : RUNTIME_LABEL[c.id]} <span className="tabular-nums opacity-60">{c.n}</span>
                </button>
              ))}
              <input
                className="input input-bordered input-xs ml-auto w-40 max-w-full"
                value={q}
                placeholder={t("搜索技能")}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <ul className="mt-2 flex list-none flex-col gap-1.5 p-0">
              {list.map((s) => (
                <SkillRow key={`${s.runtime}|${s.dir}`} s={s} home={home} showRuntime={rt === "all"} />
              ))}
            </ul>
            {list.length === 0 && <p className="mt-2 text-xs text-base-content/50">{t("没有匹配的技能")}</p>}
          </>
        )}
      </section>
      {lib && <RootsSection roots={lib.roots} home={home} />}
    </>
  );
}

function SkillRow({ s, home, showRuntime }: { s: LibrarySkill; home: string | null; showRuntime: boolean }) {
  const t = useT();
  const tag = "badge badge-xs shrink-0";
  return (
    <li className={`rounded-lg bg-base-100/70 px-3 py-2 ${s.shadowedBy ? "opacity-60" : ""}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="min-w-0 truncate font-mono text-[13px] font-medium">{s.name}</span>
        {showRuntime && <span className={`${tag} badge-ghost`}>{RUNTIME_LABEL[s.runtime]}</span>}
        <span className={`${tag} badge-ghost`}>{t(SCOPE_LABEL[s.scope])}</span>
        {s.managedBy && <span className={`${tag} badge-info badge-outline`}>{s.managedBy === "claudestra" ? "Claudestra" : "CC Switch"}</span>}
        {s.shadowedBy && <span className={`${tag} badge-warning`}>{t("被{scope}的同名技能盖过", { scope: t(SCOPE_LABEL[s.shadowedBy]) })}</span>}
        {!s.shadowedBy && s.runtime !== "claude-code" && s.sameNameElsewhere > 0 && (
          <span className={`${tag} badge-warning badge-outline`}>{t("同名还有 {n} 处", { n: s.sameNameElsewhere })}</span>
        )}
        {!s.userInvocable && <span className={`${tag} badge-ghost`}>{t("不在 / 菜单")}</span>}
        {!s.modelInvocable && <span className={`${tag} badge-ghost`}>{t("只能手动调用")}</span>}
      </div>
      {s.description && <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-base-content/60">{s.description}</p>}
      <div className="mt-0.5 truncate font-mono text-[10.5px] text-base-content/40" title={s.linkTarget ?? s.dir}>
        {shortPath(s.dir, home)}
        {s.linkTarget ? ` → ${shortPath(s.linkTarget, home)}` : ""}
      </div>
    </li>
  );
}

/** 找了哪些目录：没找到某个技能时先看这里（目录在不在、是不是这个 runtime 会读的地方） */
function RootsSection({ roots, home }: { roots: SkillRoot[]; home: string | null }) {
  const t = useT();
  const n = roots.filter((r) => r.exists).length;
  return (
    <details className="rounded-xl bg-base-200/60 p-4">
      <summary className="cursor-pointer text-[13px] font-medium">{t("找了哪些目录（{n} 个，{m} 个存在）", { n: roots.length, m: n })}</summary>
      <ul className="mt-2 flex list-none flex-col gap-1 p-0">
        {roots.map((r) => (
          <li key={`${r.runtime}|${r.scope}|${r.dir}`} className={`flex min-w-0 items-center gap-1.5 text-[11px] ${r.exists ? "" : "opacity-45"}`}>
            <span className="badge badge-xs badge-ghost shrink-0">{RUNTIME_LABEL[r.runtime]}</span>
            <span className="badge badge-xs badge-ghost shrink-0">{r.plugin ?? t(SCOPE_LABEL[r.scope])}</span>
            <span className="min-w-0 truncate font-mono" title={r.dir}>{shortPath(r.dir, home)}</span>
            {!r.exists && <span className="shrink-0 text-base-content/50">{t("不存在")}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}
