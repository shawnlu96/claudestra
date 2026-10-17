"use client";
import { useMemo } from "react";
import { useLang, useT } from "@/lib/i18n";
import { navTr } from "./nav-i18n";

/** nav/ 各组件的翻译函数：局部词表优先，其余交给全局 t（设置、用量看板等原有词条） */
export function useNavT(): ReturnType<typeof navTr> {
  const lang = useLang(), t = useT();
  return useMemo(() => navTr(lang, t), [lang, t]);
}
