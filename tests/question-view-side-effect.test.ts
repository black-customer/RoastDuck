import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("题目浏览无写入副作用", () => {
  it("题目详情和随机题跳转不会自动写 question_attempts", () => {
    const files = [
      path.join(process.cwd(), "src/components/QuestionDetailView.tsx"),
      path.join(process.cwd(), "src/components/QuestionLibrary.tsx"),
    ];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      expect(source).not.toContain('fetch("/api/question-attempts"');
      expect(source).not.toContain("status: \"viewed\"");
    }
  });
});
