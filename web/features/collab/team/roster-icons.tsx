import type { CSSProperties } from "react";
const PATHS = {
  server: <><rect x="2" y="3" width="20" height="7" rx="2" /><rect x="2" y="14" width="20" height="7" rx="2" /><path d="M6 6h.01M6 17h.01" /></>,
  pencil: <><path d="m16 3 5 5M4 20l4-1L21 6a2 2 0 0 0-3-3L5 16l-1 4Z" /></>,
  eye: <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  wrench: <path d="M14 6a5 5 0 0 0-6 6l-5 5a2 2 0 0 0 3 3l5-5a5 5 0 0 0 6-6l-3 3-3-3 3-3Z" />,
  merge: <><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="6" r="3" /><path d="M6 9v6m12-6a9 9 0 0 1-9 9" /></>,
};
export function RosterIcon({ name, style }: { name: keyof typeof PATHS; style?: CSSProperties }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{PATHS[name]}</svg>;
}
