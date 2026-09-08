import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { getDb } from "@db/client";
import { SpeakButton } from "@/components/SpeakButton";

export const dynamic = "force-dynamic";

const TYPE_LABELS: Record<string, string> = {
  collocation: "搭配", lexical_chunk: "语块", phrasal_verb: "短语动词",
  sentence_frame: "句子框架", construction: "句型", functional_expression: "功能表达", idiom: "习语",
};

export default async function ChunkDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const chunks = await db.all<Record<string, unknown>>(sql`
    SELECT c.id, c.display_chunk AS display, c.canonical_chunk AS canonical, c.unit_type AS unitType,
      c.meaning_zh AS meaningZh, c.english_gloss AS englishGloss, c.pattern,
      c.variants_json AS variantsJson, c.tags_json AS tagsJson, c.difficulty,
      t.name_zh AS topicName, t.name_en AS topicNameEn, t.id AS topicId
    FROM chunks c LEFT JOIN topics t ON t.id = c.topic_id
    WHERE c.id = ${id} LIMIT 1`);
  if (chunks.length === 0) notFound();
  const c = chunks[0];
  const examples = await db.all<Record<string, unknown>>(sql`
    SELECT text_en AS en, text_zh AS zh, is_source_sentence AS isSource
    FROM chunk_examples WHERE chunk_id = ${id} ORDER BY is_source_sentence DESC, sort`);
  const sources = await db.all<Record<string, unknown>>(sql`
    SELECT source_type AS sourceType, question_id AS questionId, source_context AS context
    FROM chunk_sources WHERE chunk_id = ${id}`);
  const questions = await db.all<Record<string, unknown>>(sql`
    SELECT DISTINCT q.id, q.text, q.part FROM questions q
    JOIN chunk_coverage_refs r ON r.question_id = q.id WHERE r.chunk_id = ${id} LIMIT 6`);
  const variants: string[] = JSON.parse((c.variantsJson as string) || "[]");

  return (
    <div className="page-content">
      <section className="page-panel">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{c.display as string}</h1>
          <SpeakButton text={c.display as string} size="lg" />
        </div>
        <p className="mt-2 text-sm text-[var(--muted)]">{TYPE_LABELS[c.unitType as string] ?? c.unitType} · {({ beginner: "基础", intermediate: "进阶", advanced: "高阶" } as Record<string, string>)[c.difficulty as string] ?? c.difficulty as string}</p>
        <p className="mt-2 text-lg text-[var(--primary)]">{c.meaningZh as string}</p>
        {Boolean(c.englishGloss) && <p className="mt-1 text-sm text-[var(--muted)]">{c.englishGloss as string}</p>}
        {(c.pattern as string) && <p className="mt-2 text-sm">Pattern：<code>{c.pattern as string}</code></p>}
        {variants.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {(variants as string[]).map((v) => (
              <span key={v} className="rounded-lg bg-[var(--card-elevated)] px-2.5 py-1 text-sm">{v}</span>
            ))}
          </div>
        )}
      </section>

      <section className="mt-5">
        <h2 className="mb-2 text-sm font-semibold text-[var(--muted)]">例句</h2>
        <div className="flex flex-col gap-3">
          {examples.map((e, i) => (
            <div key={i} className="page-panel">
              <div className="flex items-start justify-between gap-2">
                <p className="text-[15px]">{e.en as string}</p>
                <SpeakButton text={e.en as string} />
              </div>
              {Boolean(e.zh) && <p className="mt-1 text-sm text-[var(--muted)]">{e.zh as string}</p>}
              {e.isSource === 1 && <p className="mt-1 text-xs text-[var(--success)]">来自原始语料</p>}
            </div>
          ))}
        </div>
      </section>

      <section className="mt-5 grid gap-3 text-sm">
        <div className="page-panel">
          <h3 className="mb-2 font-semibold text-[var(--muted)]">来源</h3>
          <ul className="list-inside list-disc space-y-1">
            {sources.map((s, i) => (
              <li key={i}>
                {s.sourceType === "demo_answer" ? "高分示范答案" : s.sourceType === "podcast" ? "播客" : "题库"}
                {(s.context as string) && ` · ${s.context}`}
                {Boolean(s.questionId) && (
                  <Link href={`/questions/${encodeURIComponent(s.questionId as string)}`} className="ml-1 text-[var(--primary)] underline underline-offset-4">关联题目</Link>
                )}
              </li>
            ))}
          </ul>
        </div>
        {questions.length > 0 && (
          <div className="page-panel">
            <h3 className="mb-2 font-semibold text-[var(--muted)]">适用题目</h3>
            <ul className="space-y-1.5">
              {questions.map((q, i) => (
                <li key={i} className="flex gap-2">
                  <span className="rounded bg-[var(--primary-soft)] px-1.5 text-xs font-medium text-[var(--primary)]">P{q.part as number}</span>
                  <span>{(q.text as string).split("\n")[0]}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
