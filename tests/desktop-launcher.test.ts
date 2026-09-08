import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GET } from "../src/app/api/health/route";
import { parseE2ePort } from "../scripts/testing/ports";

describe("桌面启动器", () => {
  it("身份探测只返回应用与目录摘要，不包含内容或服务器配置", async () => {
    const response = await GET();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      application: "roastduck",
      workspaceId: createHash("sha256").update(process.cwd().replace(/[\\/]+$/, "").toLowerCase()).digest("hex"),
    });
  });

  it("ICO 包含真实的七档透明 PNG 图标，覆盖小图标与高 DPI", () => {
    const ico = fs.readFileSync(path.resolve("assets/desktop/app.ico"));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(7);
    const sizes: number[] = [];
    let end = 6 + 7 * 16;
    for (let index = 0; index < 7; index++) {
      const entry = 6 + index * 16;
      sizes.push(ico[entry] || 256);
      expect(ico[entry + 1]).toBe(ico[entry]);
      expect(ico.readUInt16LE(entry + 6)).toBe(32);
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      expect(offset).toBe(end);
      expect(ico.subarray(offset, offset + 8).toString("hex")).toBe("89504e470d0a1a0a");
      end = offset + length;
    }
    expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256]);
    expect(end).toBe(ico.length);
  });

  it("E2E 保留显式端口隔离，不接受非端口输入", () => {
    expect(parseE2ePort(undefined)).toBe(3100);
    expect(parseE2ePort("3102")).toBe(3102);
    for (const value of ["", "3001;exit", "0", "65536", "3.5"]) {
      expect(() => parseE2ePort(value)).toThrow();
    }
  });
});
