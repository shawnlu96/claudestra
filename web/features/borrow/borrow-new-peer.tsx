"use client";
/** 新加一条借入 / 给失效的借入重选项目：选项目 + 上限，勾一下 PUT；失败抖提交按钮、留在表单里。 */
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { machineNow, saveBorrowPeer, type BorrowView } from "./borrow-api";
import { canSubmitNew, toggleProject } from "./borrow-model";
import { LimitLine, ProjectChips, Stepper } from "./borrow-bits";
import { CheckIcon, ServerIcon, XIcon } from "./icons";
import { fadeIn, shake } from "./motion";

export function NewPeer(props: { peer: string; view: BorrowView; initMaxOpen?: number; onCancel: () => void; onChanged: () => Promise<void> }) {
  const { peer, view, onCancel, onChanged } = props;
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const limit = view.borrow.maxOpenLimit;
  const [maxOpen, setMaxOpen] = useState(() => Math.min(limit, props.initMaxOpen ?? 3));
  const [busy, setBusy] = useState(false);
  const order = view.borrow.projects.map((p) => p.id);
  useEffect(() => fadeIn(box.current), []);
  const submit = async (el: HTMLElement) => {
    setBusy(true);
    try {
      await saveBorrowPeer(peer, { projects, maxOpen }, machineNow());
      await onChanged();
      onCancel();
    } catch {
      shake(el);
      setBusy(false);
    }
  };
  return (
    <div ref={box} className="space-y-2 rounded-lg border border-dashed border-base-content/20 bg-base-100 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <ServerIcon className="size-3.5 shrink-0 text-base-content/50" />
        <span className="min-w-0 truncate font-mono text-[12.5px] font-semibold">{peer}</span>
        <button className="btn btn-ghost btn-xs btn-square ml-auto" disabled={busy} aria-label={t("取消")} onClick={onCancel}>
          <XIcon className="size-3.5" />
        </button>
        <button
          className="btn btn-primary btn-xs btn-square"
          disabled={busy || !canSubmitNew(projects, maxOpen, limit)}
          aria-label={t("借用这台电脑")}
          onClick={(e) => void submit(e.currentTarget)}
        >
          {busy ? <span className="loading loading-spinner loading-xs" /> : <CheckIcon className="size-3.5" />}
        </button>
      </div>
      <ProjectChips options={view.borrow.projects} picked={projects} disabled={busy} onToggle={(id) => setProjects((cur) => toggleProject(cur, id, order))} />
      <LimitLine name={peer} n={maxOpen}>
        <Stepper value={maxOpen} limit={limit} disabled={busy} onCommit={setMaxOpen} />
      </LimitLine>
    </div>
  );
}
