import type { Metadata } from "next";
import { PersonalBook } from "@/components/PersonalBook";
import { listPersonalBook } from "@/lib/answers/processor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "我的雅思答案｜鱼块学英语" };

export default async function PersonalBookPage() {
  return <PersonalBook initialBook={await listPersonalBook()} />;
}
