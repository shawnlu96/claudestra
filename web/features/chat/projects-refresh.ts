/**
 * GET /projects 什么时候拉（SYN-2）：roster 变了 / 显式刷新由 chat-store 直接 run()；另外两条兜底由 due() 在轮询节拍上触发——
 * 失败（503、断网）退避重试 RETRY_MS 几次（有界，首屏那次失败不至于一直没有分组），成功后每 REFRESH_MS 低频再拉一次
 * （别的设备 / CLI 改了项目名、emoji；走 304，没变不重发正文）。guest / 不发（load 回 "skip"）不重试，只按低频节拍。
 */
export type ProjectsLoad = () => Promise<"ok" | "skip" | "fail">;

export const PROJECTS_RETRY_MS = [2_000, 5_000, 15_000] as const;
export const PROJECTS_REFRESH_MS = 5 * 60_000;

export class ProjectsRefresh {
  private nextAt = 0;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly load: ProjectsLoad,
    private readonly now: () => number = Date.now,
  ) {}

  /** 低频刷新到点了（重试排着的时候不算到点） */
  due(): boolean {
    return !this.timer && !this.inflight && this.now() >= this.nextAt;
  }

  /** 拉一次；在途时并进那一次 */
  run(): Promise<void> {
    this.inflight ??= this.once().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async once(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const r = await this.load();
    if (r === "fail" && this.attempt < PROJECTS_RETRY_MS.length) {
      const wait = PROJECTS_RETRY_MS[this.attempt++];
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.run();
      }, wait);
      return;
    }
    this.attempt = 0;
    this.nextAt = this.now() + PROJECTS_REFRESH_MS;
  }
}
