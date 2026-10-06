"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ProjectFailure, projectErrorText, type ProjectSnapshot, type SharedProjectsPort } from "@/lib/shared-projects-model";

export function useProjects(port: SharedProjectsPort) {
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const refresh = useCallback(async (signal: AbortSignal) => {
    const seq = ++sequence.current;
    try {
      const next = await port.list(signal);
      if (!signal.aborted && seq === sequence.current) { setSnapshot(next); setError(""); }
    } catch (e) {
      if (!signal.aborted && seq === sequence.current) {
        setSnapshot(null); // Permission revocation must remove stale action buttons and bindings.
        setError(projectErrorText(e instanceof ProjectFailure ? e.status : 0));
      }
    }
  }, [port]);
  useEffect(() => {
    const ctrl = new AbortController();
    const load = () => void refresh(ctrl.signal);
    load();
    const timer = setInterval(load, 15_000);
    window.addEventListener("focus", load);
    return () => { ctrl.abort(); clearInterval(timer); window.removeEventListener("focus", load); };
  }, [refresh]);
  return { snapshot, error, refresh };
}

export function useProjectAction(after: (signal: AbortSignal) => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const run = async (action: (signal: AbortSignal) => Promise<void>, success = "操作已完成。") => {
    if (active.current) return;
    const ctrl = new AbortController();
    active.current = ctrl; setBusy(true); setError(""); setNotice("");
    try {
      await action(ctrl.signal);
      if (!ctrl.signal.aborted) { setNotice(success); await after(ctrl.signal); }
    } catch (e) {
      if (!ctrl.signal.aborted) setError(projectErrorText(e instanceof ProjectFailure ? e.status : 0));
    } finally {
      if (!ctrl.signal.aborted) { active.current = null; setBusy(false); }
    }
  };
  return { busy, error, notice, run };
}
