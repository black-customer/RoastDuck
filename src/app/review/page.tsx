import Link from "next/link";
import { getPracticeOverview } from "@/lib/four-step/overview";
import {LightStudy} from '@/components/light-study/LightStudy';
export const dynamic = "force-dynamic";
export default async function Page() {
  const { review } = await getPracticeOverview();
  return <div className="page-stack"><LightStudy scope={{type:'all'}} initialMode="review"/><details><summary>可选四步复习</summary><p>需要更严格的提取训练时再使用，不影响轻松学的复习进度。</p>
    {review.length ? review.map((source) => <section className="card" key={source.materialId}>
      <h2>{source.title}</h2><p>{source.sourceType === "free_talk" ? "对话复盘" : "雅思回答"} · {source.itemCount} 个待巩固表达</p>
      <Link className="primary-button" href={source.href}>{source.active ? "继续这次复习" : "开始本次复习"}</Link>
    </section>) : <section className="card"><h2>暂时没有到期的训练</h2><p>新材料完成一轮强化后，会按实际提取表现安排复习。</p><Link href="/questions">开始新的回答</Link></section>}
  </details></div>;
}
