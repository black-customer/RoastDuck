/**
 * 用户偏好（v3 `user_settings` 单行表，id 恒为 1）。
 * 默认值即产品契约，见 docs/PRODUCT.md「设置」。
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDbReady } from "@db/client";
import { userSettings } from "@db/schema";

export const ACCENTS = ["en-GB", "en-US"] as const;
export type Accent = (typeof ACCENTS)[number];

export const userSettingsSchema = z.object({
  /** 关闭时：查询、理解选择和练习错误只写学习事件，不创建难点笔记。 */
  autoCollectDifficulties: z.boolean(),
  autoPlay: z.boolean(),
  defaultAccent: z.enum(ACCENTS),
  dailyNewTarget: z.number().int().min(1).max(200),
  dailyReviewCap: z.number().int().min(1).max(1000),
  personalNewRatio: z.number().min(0).max(1),
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

export const userSettingsPatchSchema = userSettingsSchema.partial();
export type UserSettingsPatch = z.infer<typeof userSettingsPatchSchema>;

export const DEFAULT_USER_SETTINGS: UserSettings = {
  autoCollectDifficulties: false,
  autoPlay: true,
  defaultAccent: "en-US",
  dailyNewTarget: 20,
  dailyReviewCap: 100,
  personalNewRatio: 0.4,
};

function normalizeAccent(value: string): Accent {
  return (ACCENTS as readonly string[]).includes(value) ? (value as Accent) : DEFAULT_USER_SETTINGS.defaultAccent;
}

export async function getUserSettings(): Promise<UserSettings> {
  const db = await getDbReady();
  const [row] = await db.select().from(userSettings).where(eq(userSettings.id, 1)).limit(1);
  if (!row) return { ...DEFAULT_USER_SETTINGS };
  return {
    autoCollectDifficulties: row.autoCollectDifficulties,
    autoPlay: row.autoPlay,
    defaultAccent: normalizeAccent(row.defaultAccent),
    dailyNewTarget: row.dailyNewTarget,
    dailyReviewCap: row.dailyReviewCap,
    personalNewRatio: row.personalNewRatio,
  };
}

export async function updateUserSettings(patch: UserSettingsPatch): Promise<UserSettings> {
  const db = await getDbReady();
  await db.insert(userSettings).values({ id: 1, ...DEFAULT_USER_SETTINGS }).onConflictDoNothing();
  await db
    .update(userSettings)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(userSettings.id, 1));
  return getUserSettings();
}
