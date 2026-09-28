/** 多选项前的小方框（聊天里的多选行、「待你处理」卡片共用） */
export function CheckMark({ on }: { on: boolean }) {
  return (
    <span
      className={`mt-[3px] grid size-3.5 shrink-0 place-items-center rounded border text-[10px] leading-none ${
        on ? "border-primary bg-primary text-primary-content" : "border-base-content/30"
      }`}
    >
      {on ? "✓" : ""}
    </span>
  );
}
