"use client";
import { useRouter } from "next/navigation";
import { FourStepMasteryStudio } from "./FourStepMasteryStudio";
export function TrainingPage({ materialId, mode, backHref }: { materialId: string; mode: "learn" | "review"; backHref: string }) {
  const router = useRouter();
  return <FourStepMasteryStudio materialId={materialId} mode={mode} onClose={() => router.push(backHref)} />;
}
