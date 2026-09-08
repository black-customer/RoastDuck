import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { findSourceFile } from "@/lib/questions/service";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!/^[a-z0-9_]+$/.test(slug)) return NextResponse.json({ error: "来源标识不合法" }, { status: 400 });
  const sourceFile = await findSourceFile(slug);
  if (!sourceFile) return NextResponse.json({ error: "来源文件不存在" }, { status: 404 });
  const materialsDirectory = path.resolve("materials");
  const filePath = path.resolve(materialsDirectory, sourceFile);
  if (path.dirname(filePath) !== materialsDirectory) return NextResponse.json({ error: "来源路径越界" }, { status: 400 });
  try {
    const contents = await fs.readFile(filePath);
    return new NextResponse(contents, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(sourceFile)}`,
        "cache-control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "来源 PDF 暂时不可读取" }, { status: 404 });
  }
}
