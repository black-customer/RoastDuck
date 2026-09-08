/**
 * 行级文本分类与归一化工具（Content Compiler 确定性阶段共享）。
 *
 * PDF 提取的行分三类：
 *  - en    纯英文行（示范答案英文段、题干英文续行）
 *  - zh    纯中文行（示范答案中文段、题干中文续行、中文小标签）
 *  - mixed 中英混合行（题干行：英文 + 空格 + 中文翻译）
 */

const CJK_RE = /[\u2e80-\u2eff\u2f00-\u2fdf\u3000-\u303f\u31c0-\u31ef\u3200-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

export function cjkRatio(text: string): number {
  let cjk = 0;
  let letters = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++;
    else if (/[A-Za-z0-9]/.test(ch)) letters++;
  }
  const total = cjk + letters;
  return total === 0 ? 0 : cjk / total;
}

export type LineKind = "en" | "zh" | "mixed";

export function classifyLine(text: string): LineKind {
  const r = cjkRatio(text);
  if (r >= 0.5) return "zh";
  // 阈值 0.03：题干行可能只有 2-4 个汉字的中文尾巴（如「…remember? 你现在有」），不能误判为纯英文
  if (r <= 0.03) return "en";
  return "mixed";
}

/** 中英混合行拆分：首个 CJK 字符处切分（题干行 = 英文题 + 中文翻译）。 */
export function splitMixed(text: string): { en: string; zh: string } {
  const chars = Array.from(text);
  let idx = -1;
  for (let i = 0; i < chars.length; i++) {
    if (CJK_RE.test(chars[i])) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return { en: text.trim(), zh: "" };
  const en = chars.slice(0, idx).join("").trim();
  const zh = chars.slice(idx).join("").trim();
  return { en, zh };
}

/** 中文句子中的标点伪影归一（不同 PDF 使用了不同字体编码）。 */
export const ARTIFACT_RULES: Array<{ slug: string; re: RegExp; to: string }> = [
  // 全部书籍通用（Songti/PingFang 系伪影）
  { slug: "*", re: /｡/g, to: "。" },
  { slug: "*", re: /⸺/g, to: "——" },
  { slug: "*", re: /、(?=[^，。？]*[+7-])/g, to: "、" },
  // mdoors_part1_demo / mdoors_part3：+ 结尾问句，# 逗号，N…P 书名号，- 问号
  { slug: "mdoors_part1_demo_2026q2", re: /\+/g, to: "？" },
  { slug: "mdoors_part1_demo_2026q2", re: /#/g, to: "，" },
  { slug: "mdoors_part3_2026q2", re: /\+/g, to: "？" },
  { slug: "mdoors_part3_2026q2", re: /#/g, to: "，" },
  { slug: "mdoors_part3_2026q2", re: /-/g, to: "？" },
  // part1_new / part2_all_new / part3_vol：9 逗号，7 问号，/ 问号（题干尾）
  { slug: "part1_new_2026q1", re: /9/g, to: "，" },
  { slug: "part1_new_2026q1", re: /7(?=[\u4e00-\u9fff])|(?<=[\u4e00-\u9fff])7/g, to: "？" },
  { slug: "part1_new_2026q1", re: /\?\/(?=\s)|\?\/$/g, to: "？" },
  { slug: "part2_all_new", re: /9/g, to: "，" },
  { slug: "part3_vol1", re: /I(?=[\u4e00-\u9fff])|(?<=[\u4e00-\u9fff。｡])I(?![A-Za-z])/g, to: "，" },
  { slug: "part3_vol1", re: /7$/g, to: "？" },
  { slug: "part3_vol2", re: /I(?=[\u4e00-\u9fff])|(?<=[\u4e00-\u9fff。｡])I(?![A-Za-z])/g, to: "，" },
  { slug: "part3_vol2", re: /7$/g, to: "？" },
  // part2_people：W/P 冒号，b/e 括号，7 问号，句点逗号
  { slug: "part2_people", re: /(?<=[\u4e00-\u9fff])W(?![A-Za-z])/g, to: "：" },
  { slug: "part2_people", re: /(?<=[\u4e00-\u9fff])P(?![A-Za-z])/g, to: "：" },
  { slug: "part2_people", re: /(?<=[\u4e00-\u9fff])b(?![A-Za-z])/g, to: "（" },
  { slug: "part2_people", re: /(?<=[\u4e00-\u9fff])e(?![A-Za-z])/g, to: "）" },
  { slug: "part2_people", re: /(?<=[\u4e00-\u9fff])7(?![A-Za-z])/g, to: "？" },
  { slug: "part2_people", re: /(?<=[\u4e00-\u9fff])\.(?=[\u4e00-\u9fff]|$)/g, to: "，" },
  // mdoors_part2 中文组名
  { slug: "mdoors_part2_2026q2", re: /\*/g, to: "" },
];

export function normalizeZh(text: string, slug: string): string {
  let out = text;
  for (const rule of ARTIFACT_RULES) {
    if (rule.slug === "*" || rule.slug === slug) out = out.replace(rule.re, rule.to);
  }
  // 清理多余空白
  return out.replace(/\s+/g, " ").trim();
}

/** 题干归一化键：小写、去标点、压空白（用于跨书去重）。 */
export function normQuestionText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sha1Like(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c * 31, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).padStart(12, "0").slice(0, 12);
}
