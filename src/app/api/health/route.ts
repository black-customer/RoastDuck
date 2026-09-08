import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";

// 本机启动器只确认服务身份，不读数据库、不触发迁移或 Runtime AI。
export async function GET() {
  return Response.json({
    application: "roastduck",
    workspaceId: createHash("sha256").update(process.cwd().replace(/[\\/]+$/, "").toLowerCase()).digest("hex"),
  }, { headers: { "Cache-Control": "no-store" } });
}
