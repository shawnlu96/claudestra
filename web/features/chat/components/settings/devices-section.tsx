"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n";
import { machines } from "@/lib/machines";
import { listDevices, revokeDevice, type DeviceInfo } from "@/lib/api/devices";
import { useMachines } from "../../../machines/use-machines";
import { Section } from "./section";
import { AddDevicePanel } from "./add-device";

/**
 * 设置 · 设备：这台机器上所有已配对的设备（GET /api/v1/devices，要 manage 权限），本浏览器那条高亮；
 * 撤销别的设备 = 让那台手机 / 电脑下线；撤销自己 = 退出登录（bridge 回删 cookie，这里把机器从清单里摘掉）。
 * 「添加设备」在这里直接给新设备发配对码（add-device.tsx），手输短码的请求就地批准，不用回电脑终端。
 * 下面是本浏览器配对过的机器（IndexedDB，只有名字和指纹）与「添加另一台机器」。
 */
export function DevicesSection() {
  const t = useT();
  const router = useRouter();
  const { current } = useMachines();
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    listDevices()
      .then((d) => {
        setDevices(d);
        setErr("");
      })
      .catch((e: Error & { status?: number }) => setErr(e.status === 403 ? "没有管理权限，只能看到自己" : e.message));
  }, []);
  useEffect(() => {
    load();
  }, [load, current?.fp]);

  const revoke = async (d: DeviceInfo) => {
    if (armed !== d.id) return setArmed(d.id);
    setArmed(null);
    setBusy(d.id);
    try {
      await revokeDevice(d.id);
      if (d.current && current) {
        // 退出登录：凭据没了，这台机器留在清单里也打不开——摘掉；还有别的机器就切过去，否则去配对
        await machines.remove(current.fp);
        router.replace(machines.currentFp() ? "/chat" : "/pair");
        return;
      }
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      title={t("已配对的设备")}
      desc={current ? `${current.name} · ${current.fp}` : undefined}
      aside={
        devices && !adding ? (
          <button className="btn btn-sm" onClick={() => setAdding(true)}>
            {t("添加设备")}
          </button>
        ) : undefined
      }
    >
      {adding && <AddDevicePanel onClose={() => setAdding(false)} onPaired={load} />}
      {err && <div className="mb-2 text-xs text-error">{t(err)}</div>}
      {devices === null && !err && <span className="loading loading-spinner loading-xs" />}
      {devices && devices.length === 0 && <div className="text-xs text-base-content/50">{t("还没有设备")}</div>}
      {devices && devices.length > 0 && (
        <ul className="flex list-none flex-col gap-1.5 p-0">
          {devices.map((d) => (
            <li key={d.id} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${d.current ? "bg-primary/10" : ""}`}>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {d.deviceName}
                  {d.current && <span className="ml-1.5 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] text-primary">{t("本设备")}</span>}
                </span>
                <span className="block truncate text-base-content/45">
                  {d.principalName}
                  {d.lastSeenAt ? ` · ${t("最近")} ${new Date(d.lastSeenAt).toLocaleString()}` : ""}
                  {d.lastIp ? ` · ${d.lastIp}` : ""}
                </span>
              </span>
              <button
                className={`btn btn-xs ${armed === d.id ? "btn-error" : "btn-ghost text-error"}`}
                disabled={busy === d.id}
                onClick={() => void revoke(d)}
                onBlur={() => setArmed((a) => (a === d.id ? null : a))}
              >
                {busy === d.id ? <span className="loading loading-spinner loading-xs" /> : armed === d.id ? t("确定？") : d.current ? t("退出登录") : t("撤销")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** 本浏览器配对过的机器（只在中继模式有意义；直托管永远一台） */
export function MachinesSection() {
  const t = useT();
  const { list, current, multi } = useMachines();
  const [armed, setArmed] = useState<string | null>(null);
  if (!multi) return null;
  return (
    <Section
      title={t("这个浏览器里的机器")}
      aside={
        <Link href="/pair" className="btn btn-sm">
          {t("添加另一台机器")}
        </Link>
      }
    >
      <ul className="flex list-none flex-col gap-1.5 p-0">
        {list.map((m) => (
          <li key={m.fp} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{m.name}</span>
              <span className="ml-1.5 font-mono text-base-content/40">{m.fp}</span>
              {m.fp === current?.fp && <span className="ml-1.5 text-primary">✓</span>}
              {machines.healthOf(m.fp) === "repair" && <span className="badge badge-warning badge-xs ml-1.5">{t("需重新配对")}</span>}
            </span>
            <button
              className={`btn btn-xs ${armed === m.fp ? "btn-error" : "btn-ghost text-error"}`}
              onClick={() => (armed === m.fp ? void machines.remove(m.fp) : setArmed(m.fp))}
              onBlur={() => setArmed((a) => (a === m.fp ? null : a))}
            >
              {armed === m.fp ? t("确定？") : t("移除")}
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
