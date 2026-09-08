import Link from "next/link";
import { DifficultiesList } from "@/components/DifficultiesList";
import { listNotes } from "@/lib/learning/content";

export const dynamic = "force-dynamic";

export default async function DifficultiesPage() {
  const notes = await listNotes();
  const openCount = notes.filter((note) => note.status === "open").length;

  return (
    <div className="page-content">
      <header className="flex items-center justify-between gap-5">
        <Link href="/" className="exit-button -ml-2" aria-label="返回首页">
          <span aria-hidden="true">←</span>
          首页
        </Link>
        <p className="text-sm text-[var(--muted)]">{openCount} 条待处理</p>
      </header>

      <section className="mt-10">
        <p className="text-sm font-semibold text-[var(--primary-strong)]">自动笔记</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-.035em] sm:text-4xl">我的难点</h1>
        <p className="mt-4 max-w-2xl text-[.95rem] leading-7 text-[var(--muted)]">
          查过的英文、理解卡点和练习错误会自动汇总在这里。补上自己的联想，真正弄明白后再标记为已解决。
        </p>
      </section>

      <DifficultiesList initialNotes={notes} />
    </div>
  );
}
