"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 两段式确认（点一下变「确定？」，ms 毫秒无操作自动复原）——D8-11。
 *
 * 以前各处手写：全体重启 8 秒（有卸载清理）、Peer 移除 4 秒（setTimeout 没清理）……
 * 这里统一：重复 arm 会重置计时；卸载时清掉计时器；disarm 立即复原并清计时。
 * 只收「会超时复原」的那一类；侧栏删除 / 批量删除 / 定时任务与项目的删除确认不会超时
 * 复原，语义不同，没并进来。
 */
export function useArmedConfirm(ms: number) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const arm = useCallback(() => {
    setArmed(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setArmed(false), ms);
  }, [ms]);

  const disarm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setArmed(false);
  }, []);

  return { armed, arm, disarm };
}
