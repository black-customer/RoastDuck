import { NextResponse } from "next/server";
import { localJsonBody } from "@/lib/http/local-write";
import { getUserSettings, updateUserSettings, userSettingsPatchSchema } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ settings: await getUserSettings() });
}

export async function PATCH(request: Request) {
  const localBody = await localJsonBody(request);
  if (!localBody.ok) return localBody.response;
  const parsed = userSettingsPatchSchema.safeParse(localBody.body);
  if (!parsed.success) {
    return NextResponse.json({ error: "请求体不合法", issues: parsed.error.issues }, { status: 400 });
  }
  return NextResponse.json({ settings: await updateUserSettings(parsed.data) });
}
