import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// 使用 Next.js 已锁定的 sharp 依赖，将同一矢量源编译为 Windows 多尺寸图标。
const directory = fileURLToPath(new URL("../../assets/desktop/", import.meta.url));
const source = await fs.readFile(path.join(directory, "app.svg"));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map((size) => sharp(source).resize(size, size).png().toBuffer()));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
images.forEach((png, index) => {
  const entry = 6 + index * 16;
  header[entry] = sizes[index] === 256 ? 0 : sizes[index];
  header[entry + 1] = header[entry];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});
await fs.writeFile(path.join(directory, "app.ico"), Buffer.concat([header, ...images]));
await fs.writeFile(path.join(directory, "app.png"), images.at(-1));
console.log(`桌面图标已生成：${sizes.join(" / ")} px`);
