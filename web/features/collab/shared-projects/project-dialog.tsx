"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function ProjectDialog({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return createPortal(
    <dialog ref={dialog} className="modal bg-base-200" aria-label={title} onCancel={close}>
      <div className="modal-box max-w-2xl space-y-5">
        <header className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={close}>关闭</button>
        </header>
        {children}
      </div>
    </dialog>, document.body,
  );
}

export function ActionStatus({ error, notice }: { error: string; notice: string }) {
  return <>
    {error && <p className="text-sm text-error" role="alert">{error}</p>}
    {notice && <p className="text-sm text-success" role="status">{notice}</p>}
  </>;
}
