/**
 * canonical 归一化（确定性）：时态/缩写/标点/大小写归一，用于去重与调度。
 * display_chunk 保留生成时的自然形态。规则对齐 docs/CONTENT_SPEC.md §3.1。
 */

const CONTRACTIONS: Array<[RegExp, string]> = [
  [/\bi'm\b/g, "i am"],
  [/\bit's\b/g, "it is"],
  [/\bthat's\b/g, "that is"],
  [/\bthere's\b/g, "there is"],
  [/\bwhat's\b/g, "what is"],
  [/\blet's\b/g, "let us"],
  [/\bdon't\b/g, "do not"],
  [/\bdoesn't\b/g, "does not"],
  [/\bdidn't\b/g, "did not"],
  [/\bcan't\b/g, "can not"],
  [/\bcannot\b/g, "can not"],
  [/\bcouldn't\b/g, "could not"],
  [/\bwouldn't\b/g, "would not"],
  [/\bshouldn't\b/g, "should not"],
  [/\bisn't\b/g, "is not"],
  [/\baren't\b/g, "are not"],
  [/\bwasn't\b/g, "was not"],
  [/\bweren't\b/g, "were not"],
  [/\bhaven't\b/g, "have not"],
  [/\bhasn't\b/g, "has not"],
  [/\bwon't\b/g, "will not"],
  [/\bi'd\b/g, "i would"],
  [/\bi've\b/g, "i have"],
  [/\bi'll\b/g, "i will"],
  [/\byou're\b/g, "you are"],
  [/\bthey're\b/g, "they are"],
  [/\bwe're\b/g, "we are"],
  [/\bhe's\b/g, "he is"],
  [/\bshe's\b/g, "she is"],
  [/\bwe'd\b/g, "we would"],
  [/\bthey'd\b/g, "they would"],
  [/\bwe've\b/g, "we have"],
  [/\bthey've\b/g, "they have"],
  [/\byou'll\b/g, "you will"],
  [/\bwe'll\b/g, "we will"],
  [/\bthey'll\b/g, "they will"],
  [/\bhe'll\b/g, "he will"],
  [/\bshe'll\b/g, "she will"],
  [/\bit'll\b/g, "it will"],
];

export function canonicalize(display: string): string {
  let s = display.toLowerCase();
  s = s.replace(/[\u2018\u2019\u02bc]/g, "'");
  s = s.replace(/[\u201c\u201d]/g, '"');
  s = s.replace(/[\u2013\u2014]/g, "-");
  s = s.replace(/\u2026/g, "...");
  s = s.replace(/\.\.\./g, " ");
  for (const [re, to] of CONTRACTIONS) s = s.replace(re, to);
  // 去首尾与多余标点（保留词内 ' 与 -）
  s = s.replace(/[^a-z0-9' \-]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  // 去尾部助词（be going to do 之类不做语义归并，仅形态）
  return s;
}

/** 简单动词原形归一（仅高频不规则+规则后缀），用于 did→do 级别的形态合并。 */
const IRREGULAR: Record<string, string> = {
  was: "be", were: "be", been: "be", being: "be", am: "be", is: "be", are: "be",
  did: "do", does: "do",
  had: "have", has: "have", having: "have",
  went: "go", gone: "go", goes: "go", going: "go",
  got: "get", gotten: "get", gets: "get", getting: "get",
  made: "make", makes: "make", making: "make",
  took: "take", taken: "take", takes: "take", taking: "take",
  said: "say", says: "say", saying: "say",
  came: "come", comes: "come", coming: "come",
  saw: "see", seen: "see", sees: "see", seeing: "see",
  knew: "know", known: "know", knows: "know", knowing: "know",
  thought: "think", thinks: "think", thinking: "think",
  felt: "feel", feels: "feel", feeling: "feel",
  found: "find", finds: "find", finding: "find",
  gave: "give", given: "give", gives: "give", giving: "give",
  told: "tell", tells: "tell", telling: "tell",
  became: "become", becomes: "become", becoming: "become",
  spent: "spend", spends: "spend", spending: "spend",
  kept: "keep", keeps: "keep", keeping: "keep",
  began: "begin", begun: "begin", begins: "begin", beginning: "begin",
  brought: "bring", brings: "bring", bringing: "bring",
  grew: "grow", grown: "grow", grows: "grow", growing: "grow",
  built: "build", builds: "build", building: "build",
  sat: "sit", sits: "sit", sitting: "sit",
  stood: "stand", stands: "stand", standing: "stand",
  ran: "run", runs: "run", running: "run",
  wore: "wear", worn: "wear", wears: "wear", wearing: "wear",
  ate: "eat", eaten: "eat", eats: "eat", eating: "eat",
  spoke: "speak", spoken: "speak", speaks: "speak", speaking: "speak",
  wrote: "write", written: "write", writes: "write", writing: "write",
  read: "read", reads: "read", reading: "read",
  met: "meet", meets: "meet", meeting: "meet",
  paid: "pay", pays: "pay", paying: "pay",
  put: "put", puts: "put", putting: "put",
  set: "set", sets: "set", setting: "set",
  left: "leave", leaves: "leave", leaving: "leave",
  lost: "lose", loses: "lose", losing: "lose",
  sent: "send", sends: "send", sending: "send",
  built_: "build",
  chose: "choose", chosen: "choose", chooses: "choose", choosing: "choose",
  broke: "break", broken: "break", breaks: "break", breaking: "break",
  spoke_: "speak",
  drove: "drive", driven: "drive", drives: "drive", driving: "drive",
  enjoyed_: "enjoy",
};

/**
 * 生成 canonical 的"词元形态"变体集合：首词（动词）原形归一后的形态。
 * dedup 用两种形态都比对：expandContractions(canonical) 与 verbNormalized(canonical)。
 */
export function verbNormalize(canonical: string): string {
  return canonical
    .split(" ")
    .map((w, i) => {
      if (i === 0 && IRREGULAR[w]) return IRREGULAR[w];
      return w;
    })
    .join(" ");
}

/** -ing / -s 粗归一（仅首词）。 */
export function verbNormalizeLoose(canonical: string): string {
  const words = canonical.split(" ");
  let first = words[0];
  first = IRREGULAR[first] ?? first;
  if (first.endsWith("ing") && first.length > 5) {
    const stem = first.slice(0, -3);
    first = IRREGULAR[stem] ?? stem;
  } else if (first.endsWith("s") && first.length > 3) {
    first = first.slice(0, -1);
    first = IRREGULAR[first] ?? first;
  }
  words[0] = first;
  return words.join(" ");
}

/** 词集 Jaccard 相似度（近似重复检测）。 */
export function tokenJaccard(a: string, b: string): number {
  const sa = new Set(a.split(" ").filter(Boolean));
  const sb = new Set(b.split(" ").filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}
