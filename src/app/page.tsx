import { HomeDashboard } from "@/components/home/HomeDashboard";
import { getSentenceHomeOverview } from "@/lib/sentence-study/home";

export const dynamic = "force-dynamic";

export default async function Home() {
  // 不将读取故障伪装为零进度；用户仍可通过导航访问已有页面。
  const overview = await getSentenceHomeOverview().catch(() => null);
  return <HomeDashboard overview={overview} />;
}
