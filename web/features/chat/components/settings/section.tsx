"use client";
/** 设置分区卡片(owner 2026-07-24「排版丑」→ iOS 分组式):统一「标题+右侧
 *  控件+说明+内容」结构,六个功能块同一版式。⚠ 必须定义在模块层——组件内
 *  定义每次渲染都是新类型,内部输入框会随重挂载丢焦点。 */
export function Section({
  title,
  aside,
  desc,
  children,
}: {
  title: React.ReactNode;
  aside?: React.ReactNode;
  desc?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl bg-base-200/60 p-4">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <span className="text-[13.5px] font-semibold">{title}</span>
        {aside}
      </div>
      {desc && <p className="mt-0.5 text-xs leading-relaxed text-base-content/50">{desc}</p>}
      {children && <div className="mt-3">{children}</div>}
    </section>
  );
}

/** 设置分组标题(owner 2026-08-26「按 type 归类,不是 tab」):卡片流里的轻量组头。 */
export function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-0.5 mt-4 px-1 text-[11px] font-semibold uppercase tracking-wider text-base-content/40 first:mt-0">
      {children}
    </div>
  );
}
