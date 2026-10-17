"use client";
import { useLang } from "@/lib/i18n";
import { cardModelT } from "./card-model-copy";
export { CARD_EFFORT_LABELS, CARD_ROLE_LABELS, CARD_TIER_LABELS, cardModelError } from "./card-model-copy";

export function useCardModelT() {
  const lang = useLang();
  return (text: string) => cardModelT(lang, text);
}
