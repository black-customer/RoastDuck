import type { ReactNode } from "react";

export type IconName = "home" | "questions" | "answers" | "book" | "search" | "settings" | "memory" | "arrow" | "shuffle" | "audio" | "check" | "menu" | "speaking";
export function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    home: <><path d="m3 10 9-7 9 7v10H3Z" /><path d="M9 20v-7h6v7" /></>,
    questions: <><path d="M4 4h16v13H9l-5 4Z" /><path d="M8 9h8M8 13h5" /></>,
    speaking: <><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8" /></>,
    answers: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h3M3 7h3M3 12h3M3 17h3" /></>,
    book: <><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Z" /><path d="M12 5v15" /></>,
    search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></>,
    settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2" fill="currentColor" /><circle cx="15" cy="17" r="2" fill="currentColor" /></>,
    memory: <><path d="M8 5.5A4.5 4.5 0 0 0 7 14v3.5a2 2 0 0 0 2 2h3V8a4 4 0 0 0-4-4Z" /><path d="M16 5.5A4.5 4.5 0 0 1 17 14v3.5a2 2 0 0 1-2 2h-3M7.3 9H4.5M16.7 9h2.8M8 14h4m4 0h-4" /></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    shuffle: <><path d="M3 6h3c5 0 7 12 12 12h3m-4-4 4 4-4 4M3 18h3c2 0 3-2 4-4m4-4c1-2 2-4 4-4h3m-4-4 4 4-4 4" /></>,
    audio: <><path d="M5 10v4m4-8v12m4-15v18m4-15v12m4-8v4" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function BrandMark() {
  return <svg width="39" height="39" viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="13" fill="var(--primary-soft)" /><path d="m7 18 10 6-10 6Z" fill="var(--foreground)" /><path d="M23 13h6a11 11 0 0 1 0 22h-6a5 5 0 0 1-5-5V18a5 5 0 0 1 5-5Z" fill="var(--primary)" /><circle cx="33" cy="21" r="1.7" fill="var(--card)" /></svg>;
}
