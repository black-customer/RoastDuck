import type { Metadata } from "next";
import { FreeTalkChat } from "@/components/FreeTalkChat";
import {webCompanion,conversationView} from '@/lib/app-services/web';

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "AI Free Talk 口语对练｜鱼块学英语" };

export default async function FreeTalkPage({ searchParams }: { searchParams: Promise<{ conversation?: string }> }) {
  const conversations = (await webCompanion().chat.list()).map(conversationView);
  const active = (await searchParams).conversation;
  return <FreeTalkChat initialConversations={conversations} activeConversationId={conversations.some((c) => c.id === active) ? active : undefined} />;
}
