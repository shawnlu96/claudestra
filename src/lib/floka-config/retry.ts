/** A stale snapshot is safe to retry only when the setter can replay its intent on a fresh read. */
export class ConfigChangedError extends Error {
  constructor(message = "config changed since read; refusing stale automatic overwrite") {
    super(message);
    this.name = "ConfigChangedError";
  }
}

/** Exactly one fresh read/modify/write; validation, maintenance and I/O errors are never retried. */
export async function retryConfigWrite<T>(edit: () => Promise<T>): Promise<T> {
  try { return await edit(); } catch (e) {
    if (!(e instanceof ConfigChangedError)) throw e;
  }
  try { return await edit(); } catch (e) {
    if (!(e instanceof ConfigChangedError)) throw e;
    const failure = new ConfigChangedError("配置刚被别处改过,请重试");
    console.error(`[floka-config] ${failure.message}`);
    throw failure;
  }
}
