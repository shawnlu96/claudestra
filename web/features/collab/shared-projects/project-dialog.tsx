"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { sharedProjectsTr } from "@/lib/i18n-dict-shared-projects";
import { useLang } from "@/lib/i18n";

export function ProjectDialog({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const tr = sharedProjectsTr(useLang());
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return createPortal(
    <dialog ref={dialog} className="modal bg-base-200" aria-label={title} onCancel={close}>
      <div className="modal-box max-w-2xl space-y-5">
        <header className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">{tr(title)}</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={close}>{tr("关闭")}</button>
        </header>
        {children}
      </div>
    </dialog>, document.body,
  );
}

/** error / notice arrive as the Chinese sentences of projectErrorText or the caller's success text; they are translated here. */
export function ActionStatus({ error, notice }: { error: string; notice: string }) {
  const tr = sharedProjectsTr(useLang());
  return <>
    {error && <p className="text-sm text-error" role="alert">{tr(error)}</p>}
    {notice && <p className="text-sm text-success" role="status">{tr(notice)}</p>}
  </>;
}
