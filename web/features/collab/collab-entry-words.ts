/** Translate the sidebar collab-entry retry label locally (short status words stay out of the global dictionary). */
import type { Lang } from "@/lib/i18n";
const WORDS: Record<string, string> = {
  '没读到，点一下重试': "Couldn't load, tap to retry",
};
export function entryText(lang: Lang, text: string): string {
  return lang === 'en' ? WORDS[text] ?? text : text;
}
