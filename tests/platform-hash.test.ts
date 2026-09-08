import { createHash } from "node:crypto";
import { expect,it } from "vitest";
import { sha256Text,hashParts } from "../src/lib/platform/hash";
it("portable SHA-256 retains byte-identical UTF-8 and legacy JSON tuple IDs",()=>{
  for(const input of ["","abc","中文刷牙", "I’d like to reschedule.", "Ａe\u0301", "\ud800", "\u0000\ufeff\n", "🙂".repeat(300)]){
    expect(sha256Text(input)).toBe(createHash("sha256").update(input).digest("hex"));
    const parts=[input,0,-1,1.25,Number.NaN,Number.POSITIVE_INFINITY];
    expect(hashParts(...parts)).toBe(createHash("sha256").update(JSON.stringify(parts)).digest("hex"));
  }
  expect(hashParts("ab","c")).not.toBe(hashParts("a","bc"));
  expect(sha256Text("Ａ")).not.toBe(sha256Text("A"));
});
