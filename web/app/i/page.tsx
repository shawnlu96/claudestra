"use client";
/**
 * /i：协作邀请落地页（邀请链接 https://<base>/i#<邀请码>）。中继配了静态前端后由这里接（src/relay/front.ts 只在没配静态目录时
 * 才画自己的页）。托管前端就是应用本体，不用再问「你的 Claudestra 叫什么」：直接进 /join 确认；没配对过机器的会被
 * MachineGate 送去 /pair，配完带着邀请码回来。邀请码只在 # 里，不上服务器。
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function InviteLanding() {
  const router = useRouter();
  useEffect(() => {
    router.replace(`/join${window.location.hash}`);
  }, [router]);
  return null;
}
