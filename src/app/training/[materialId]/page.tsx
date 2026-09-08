import { notFound } from "next/navigation";
import { TrainingPage } from "@/components/TrainingPage";
import { getMaterial } from "@/lib/four-step/materials";
export const dynamic = "force-dynamic";
export default async function Page({ params, searchParams }: { params: Promise<{ materialId: string }>; searchParams: Promise<{ mode?: string }> }) {
  const { materialId } = await params;
  const material = await getMaterial(materialId).catch(() => null);
  if (!material) notFound();
  const mode = (await searchParams).mode === "review" ? "review" : "learn";
  return <TrainingPage materialId={materialId} mode={mode} backHref={material.question_id ? `/questions/${encodeURIComponent(material.question_id)}` : `/free-talk?conversation=${encodeURIComponent(material.source_id)}`} />;
}
