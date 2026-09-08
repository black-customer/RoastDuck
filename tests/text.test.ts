import { describe, expect, it } from "vitest";
import {
  classifyLine,
  normQuestionText,
  normalizeZh,
  sha1Like,
  splitMixed,
} from "@pipeline/src/lib/text";

describe("classifyLine", () => {
  it("纯英文行", () => {
    expect(classifyLine("My little robot carries a purple umbrella on sunny days.")).toBe("en");
    expect(classifyLine("Describe a robot that delivers umbrellas to a floating library")).toBe("en");
  });

  it("纯中文行", () => {
    expect(classifyLine("小机器人正在给漂浮的图书馆送伞。这是原创测试句。")).toBe("zh");
    expect(classifyLine("机器人送伞")).toBe("zh");
  });

  it("中英混合行（题干）", () => {
    expect(classifyLine("Do robots need umbrellas? 机器人需要雨伞吗？")).toBe("mixed");
    expect(classifyLine("3. Have you ever visited a library that floats above the clouds? 你现在有")).toBe("mixed");
  });

  it("中文答案里嵌英文单词仍为 zh", () => {
    expect(
      classifyLine("这个原创测试里有个叫Robot的小机器人，它正在给云上的图书馆运送五颜六色的雨伞。"),
    ).toBe("zh");
  });

  it("题干尾部只有一个汉字仍判 en（由 questionSize 兜底）", () => {
    const text = "What would happen if every little robot carried a bright purple umbrella today? 在";
    expect(classifyLine(text)).toBe("en");
  });
});

describe("splitMixed", () => {
  it("首个 CJK 处切分", () => {
    const { en, zh } = splitMixed("Where is the robot? 机器人在哪里？");
    expect(en).toBe("Where is the robot?");
    expect(zh).toBe("机器人在哪里？");
  });

  it("编号保留在英文部分", () => {
    const { en } = splitMixed("1. Do you have a purple robot? 你有紫色机器人吗");
    expect(en.startsWith("1. Do you have")).toBe(true);
  });

  it("无中文返回空 zh", () => {
    const { en, zh } = splitMixed("Pure English line.");
    expect(zh).toBe("");
    expect(en).toBe("Pure English line.");
  });
});

describe("normalizeZh", () => {
  it("mdoors 伪影映射", () => {
    expect(normalizeZh("机器人收到雨伞了吗+", "mdoors_part1_demo_2026q2")).toBe("机器人收到雨伞了吗？");
    expect(normalizeZh("机器人先展开雨伞#再穿过云层去送书｡", "mdoors_part1_demo_2026q2")).toContain(
      "，",
    );
  });

  it("part1_new 伪影映射", () => {
    expect(normalizeZh("云层很厚9机器人收起雨伞9继续向图书馆飞行｡", "part1_new_2026q1")).toContain("，");
  });

  it("part2_people 伪影映射", () => {
    expect(normalizeZh("这把伞是紫色的.机器人拿着它.飞向云上的书架", "part2_people")).toContain("，");
  });

  it("英文内容不受中文伪影规则影响", () => {
    expect(normalizeZh("Hello world 7 plus", "part1_new_2026q1")).toBe("Hello world 7 plus");
  });
});

describe("normQuestionText", () => {
  it("跨书去重键：忽略大小写、标点、空白差异", () => {
    expect(normQuestionText("Do you carry a purple umbrella?")).toBe(
      normQuestionText("do you carry a purple umbrella"),
    );
    expect(normQuestionText("Describe a robot that delivered a purple umbrella to a floating library")).toBe(
      normQuestionText("Describe a robot that delivered a purple umbrella to a floating library."),
    );
  });

  it("不同题目键不同", () => {
    expect(normQuestionText("Do you like robots?")).not.toBe(normQuestionText("Do you like umbrellas?"));
  });
});

describe("sha1Like", () => {
  it("稳定且可区分", () => {
    expect(sha1Like("abc")).toBe(sha1Like("abc"));
    expect(sha1Like("abc")).not.toBe(sha1Like("abd"));
    expect(sha1Like("abc")).toMatch(/^[0-9a-z]{12}$/);
  });
});
