"use client";
/** /login 只剩一个跳转：账号密码 / passkey / TOTP 随 BFF 一起删了，登录 = 设备配对（/pair）。老书签、壳里存的地址还会指到这里。 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LoginRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace(`/pair${window.location.hash}`);
  }, [router]);
  return null;
}
