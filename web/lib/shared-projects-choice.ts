export interface SharedProjectChoice {
  selectId: string;
  recommended: string;
  options: { value: string; label: string; description?: string }[];
}

/** A recommendation selects a real option, never submits authorization on behalf of the owner. */
export function projectChoice(extra: unknown, rows: unknown): SharedProjectChoice | null {
  if (!extra || typeof extra !== "object") return null;
  const value = (extra as { sharedProjectChoice?: unknown }).sharedProjectChoice;
  if (!value || typeof value !== "object") return null;
  const { selectId, recommended } = value as { selectId?: unknown; recommended?: unknown };
  if (typeof selectId !== "string" || !/^[\w-]{1,128}$/.test(selectId) || typeof recommended !== "string" || !Array.isArray(rows)) return null;
  const select = rows.find(r => r?.type === "select" && r.id === selectId);
  if (!select || !Array.isArray(select.options) || select.options.length > 500) return null;
  const options: SharedProjectChoice["options"] = [];
  for (const o of select.options) {
    if (!o || typeof o.value !== "string" || !/^[\w:.-]{1,256}$/.test(o.value) || typeof o.label !== "string" || o.label.length > 256) return null;
    if (options.some(p => p.value === o.value)) return null;
    options.push({ value: o.value, label: o.label,
      ...(typeof o.description === "string" && o.description.length <= 500 ? { description: o.description } : {}) });
  }
  return { selectId, options, recommended: options.some(o => o.value === recommended) ? recommended : "" };
}

export function projectChoiceWire(choice: SharedProjectChoice, selected: string): string | null {
  return choice.options.some(o => o.value === selected) ? `[select:${choice.selectId}:${selected}]` : null;
}
