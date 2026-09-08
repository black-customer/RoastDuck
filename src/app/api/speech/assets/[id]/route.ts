import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { findAudioAsset } from "@/lib/speech/service";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const asset = await findAudioAsset(id);
  if (!asset) return NextResponse.json({ error: "音频不存在或尚未生成" }, { status: 404 });
  const bytes = await fs.readFile(asset.absolutePath);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": asset.format === "wav" ? "audio/wav" : "application/octet-stream",
      "cache-control": "private, max-age=31536000, immutable",
      "content-length": String(bytes.byteLength),
      "x-content-type-options": "nosniff",
    },
  });
}
