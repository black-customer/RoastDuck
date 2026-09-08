"use client";

import type { HTMLAttributes } from "react";
import type { InteractiveText } from "@/lib/learning/types";

function normalized(value: string): string {
  return value.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z'\s-]/g, "").replace(/\s+/g, " ").trim();
}

export function InteractiveEnglishText({
  content,
  onLookup,
  highlightSurface,
  className = "",
  ...props
}: {
  content: InteractiveText;
  onLookup: (annotationId: string) => void;
  highlightSurface?: string;
} & Omit<HTMLAttributes<HTMLParagraphElement>, "content">) {
  const annotations = [...content.annotations].sort((a, b) => a.start - b.start || b.end - a.end);
  const pieces: React.ReactNode[] = [];
  let cursor = 0;
  const highlight = normalized(highlightSurface ?? "");

  for (const annotation of annotations) {
    if (annotation.start < cursor || annotation.end <= annotation.start || annotation.end > content.text.length) continue;
    if (annotation.start > cursor) pieces.push(content.text.slice(cursor, annotation.start));
    const annotationSurface = normalized(annotation.surface);
    const isHighlight = Boolean(highlight && (annotationSurface === highlight || annotationSurface.includes(highlight)));
    pieces.push(
      <button
        type="button"
        key={annotation.id}
        className="interactive-english"
        data-highlight={isHighlight ? "true" : "false"}
        onClick={() => onLookup(annotation.id)}
        aria-label={`查看 ${annotation.surface} 的解释`}
      >
        {content.text.slice(annotation.start, annotation.end)}
      </button>,
    );
    cursor = annotation.end;
  }
  if (cursor < content.text.length) pieces.push(content.text.slice(cursor));

  return (
    <p lang="en" className={className} {...props}>
      {pieces}
    </p>
  );
}
