/**
 * authedLegacy 的错误 body（从 web/lib/bff.ts 原样搬出）：单独成文件是为了保持纯——
 * 不 import next/server / api-auth，tests/ 才能直接单测它（guard 的 tests-web-pure 规则）。
 */

/** 纯函数（单测锁形状）：旧口径的错误 body。没有前缀时 message 原样（undefined 会被 JSON 省掉，同迁移前） */
export async function legacyErrorBody(
  e: unknown,
  opts: { okFalse?: boolean; errorPrefix?: string | (() => Promise<string>) } = {},
): Promise<{ ok?: false; error?: string }> {
  const raw = (e as Error).message;
  let error: string | undefined = raw;
  if (opts.errorPrefix !== undefined) {
    const prefix = typeof opts.errorPrefix === "string" ? opts.errorPrefix : await opts.errorPrefix();
    error = `${prefix}${raw}`;
  }
  return opts.okFalse ? { ok: false, error } : { error };
}
