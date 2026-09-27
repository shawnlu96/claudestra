"use client";
import { useEffect, useState } from "react";
import { fetchVersion, type VersionInfo } from "@/lib/api/version";

/** 挂载时拉一次版本（侧栏徽标 / 导出抬头 / 启动页署名共用；失败保持 null，不打扰） */
export function useVersionInfo(): VersionInfo | null {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  useEffect(() => {
    let alive = true;
    fetchVersion()
      .then((v) => alive && (v.version || v.commit) && setInfo(v))
      .catch(() => {}); // 版本拿不到就不显示署名，功能不受影响
    return () => {
      alive = false;
    };
  }, []);
  return info;
}
