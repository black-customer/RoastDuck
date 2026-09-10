import { notFound } from "next/navigation";
import { TrainingPage } from "@/components/TrainingPage";
import { getMaterial } from "@/lib/four-step/materials";
import {LegacyModeGate,extensionHref} from '@/components/sentence-study/LegacyModeGate';
export const dynamic = "force-dynamic";
export default async function Page({ params, searchParams }: { params: Promise<{ materialId: string }>; searchParams: Promise<{ mode?: string;extension?:string }> }) {
  const { materialId } = await params;
  const query=await searchParams;
  if(query.extension!=='1')return <LegacyModeGate title="四步强化" href={extensionHref(`/training/${encodeURIComponent(materialId)}`,query)}/>;
  const material = await getMaterial(materialId).catch(() => null);
  if (!material) notFound();
  const mode = query.mode === "review" ? "review" : "learn";
  return <TrainingPage materialId={materialId} mode={mode} backHref={material.question_id ? `/questions/${encodeURIComponent(material.question_id)}` : `/free-talk?conversation=${encodeURIComponent(material.source_id)}`} />;
}
