import Link from "next/link";
import { getUserSettings } from "@/lib/settings";
import { SettingsForm } from "@/components/SettingsForm";
import { PageHeader } from "@/components/ui/PageHeader";
import {SpeechSettings} from '@/components/SpeechSettings';
import {DataBackupSettings} from '@/components/DataBackupSettings';
import {SentenceSettings} from '@/components/SentenceSettings';
import {APP_VERSION} from '@/lib/version';

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await getUserSettings();

  return (
    <div className="settings-shell">
      <div className="settings-frame">
        <PageHeader title="学习设置" description="按你的节奏学习。句子学习默认只需回想、揭晓和自评。" />
        <SentenceSettings/>
        <SettingsForm initialSettings={settings} />
        <SpeechSettings/>
        <DataBackupSettings/>
        <nav className="settings-links" aria-label="数据与内容"><Link href="/companion-memories">Chloe 记得什么</Link><Link href="/review-content">异常与内容管理</Link><Link href="/difficulties">查看已有笔记</Link></nav>
        <p className="settings-links">鱼块学英语 · v{APP_VERSION} · 本机网页版</p>
      </div>
    </div>
  );
}
