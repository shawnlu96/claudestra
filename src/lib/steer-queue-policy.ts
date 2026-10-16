/** Missing or malformed configuration keeps the default non-preempting collab send behavior. */
export function steerQueueWhenBusy(cfg: { steer?: unknown }): boolean {
  const steer = cfg.steer;
  return !(steer && typeof steer === "object" && "queueWhenBusy" in steer && steer.queueWhenBusy === false);
}
