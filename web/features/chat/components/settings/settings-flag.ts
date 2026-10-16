"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getSettings, putSettings } from "@/lib/api/settings";
import { machines } from "@/lib/machines";

type Flag = "pushNoContent" | "pushAllAsks" | "talkEnabled" | "steer.queueWhenBusy";
const listeners = new Set<(key: Flag, fp: string | null, on: boolean) => void>();
const subscribeMachine = (notify: () => void) => machines.subscribe(notify);
const machineFp = () => machines.currentFp();
const noMachine = () => null;

/** Global settings flags share successful writes so mounted senders follow the rollback toggle immediately. */
export function useSettingsFlag(key: Flag, open = true, onChanged?: (on: boolean) => void) {
  const fp = useSyncExternalStore(subscribeMachine, machineFp, noMachine);
  const [rec, setRec] = useState<{ key: Flag; fp: string | null; on: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const read = useRef(0);
  const on = rec?.key === key && rec.fp === fp ? rec.on : null;
  useEffect(() => {
    if (!open) return;
    let live = true;
    const refresh = () => {
      const ticket = ++read.current;
      getSettings().then((j) => {
        if (live && ticket === read.current) { setRec({ key, fp, on: j[key] }); setErr(""); }
      }).catch((e: Error) => { if (live && ticket === read.current) setErr(e.message); });
    };
    const changed = (k: Flag, source: string | null, value: boolean) => {
      if (k !== key || source !== fp) return;
      ++read.current;
      setRec({ key, fp, on: value });
    };
    refresh();
    listeners.add(changed);
    window.addEventListener("focus", refresh);
    return () => { live = false; listeners.delete(changed); window.removeEventListener("focus", refresh); };
  }, [open, key, fp]);
  const toggle = async () => {
    if (on === null || busy) return;
    setBusy(true);
    setErr("");
    try {
      const next = (await putSettings({ [key]: !on }))[key];
      ++read.current;
      setRec({ key, fp, on: next });
      for (const changed of listeners) changed(key, fp, next);
      onChanged?.(next);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { on, busy, err, toggle };
}
