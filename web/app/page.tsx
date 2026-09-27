"use client";
/** 首页只是分流：配对过机器 → /chat；一台都没有 → /pair。静态导出没有服务端 redirect，只能在浏览器里判 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { machines } from "@/lib/machines";
import { bootMachines } from "@/features/machines/use-machines";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    void bootMachines().then((cfg) => router.replace(cfg.mode === "direct" || machines.currentFp() ? "/chat" : "/pair"));
  }, [router]);
  return <div className="fixed inset-0 bg-base-100" aria-hidden />;
}
