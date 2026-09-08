import type { Metadata } from "next";
import { MemoryCenter } from "@/components/MemoryCenter";
import { listCompanionMemories } from "@/lib/companion/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Chloe 记得什么｜鱼块学英语" };

export default async function CompanionMemoriesPage() {
  return <MemoryCenter initialMemories={await listCompanionMemories()} />;
}
