import { NextResponse } from "next/server";
import { getUserSettings, updateUserSettings, userSettingsPatchSchema } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ settings: await getUserSettings() });
}

export async function PATCH(request: Request) {
  const parsed = userSettingsPatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "请求体不合法", issues: parsed.error.issues }, { status: 400 });
  }
  return NextResponse.json({ settings: await updateUserSettings(parsed.data) });
}
