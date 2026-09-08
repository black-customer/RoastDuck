import type { MockAiResolver } from "@/lib/ai/mock-provider";

const sentence = "I stay focused by putting my phone in another room.";
const sentenceZh = "我通过把手机放到另一个房间来保持专注。";

const candidate = {
  sentenceIndex: 0,
  displayChunk: "stay focused",
  canonicalChunk: "stay focused",
  unitType: "lexical_chunk",
  meaningZh: "保持专注",
  englishGloss: "to keep your attention on what you are doing",
  pattern: "stay focused + by/on/when ...",
  ipa: "steɪ ˈfoʊkəst",
  exampleEn: sentence,
  exampleZh: sentenceZh,
  lexemes: [
    { surface: "I", meaningZh: "我", ipa: "aɪ" },
    { surface: "stay", meaningZh: "保持", ipa: "steɪ" },
    { surface: "focused", meaningZh: "专注的", ipa: "ˈfoʊkəst" },
    { surface: "by", meaningZh: "通过", ipa: "baɪ" },
    { surface: "putting", meaningZh: "放置", ipa: "ˈpʊtɪŋ" },
    { surface: "my", meaningZh: "我的", ipa: "maɪ" },
    { surface: "phone", meaningZh: "手机", ipa: "foʊn" },
    { surface: "in", meaningZh: "在……里面", ipa: "ɪn" },
    { surface: "another", meaningZh: "另一个", ipa: "əˈnʌðə" },
    { surface: "room", meaningZh: "房间", ipa: "ruːm" },
  ],
};

const correctionGapCandidate = {
  sentenceIndex: 0,
  displayChunk: "putting my phone in another room",
  canonicalChunk: "putting my phone in another room",
  unitType: "lexical_chunk",
  meaningZh: "把手机放到另一个房间",
  englishGloss: "moving your phone to a different room to avoid distraction",
  pattern: "by putting + object + in another room",
  ipa: "ˈpʊtɪŋ maɪ foʊn ɪn əˈnʌðər ruːm",
  exampleEn: sentence,
  exampleZh: sentenceZh,
  lexemes: candidate.lexemes,
};

const speakingGlossary = [
  ...candidate.lexemes,
  { surface: "focus", meaningZh: "专注", ipa: "ˈfəʊkəs" },
  { surface: "distraction", meaningZh: "干扰", ipa: "dɪˈstrækʃən" },
  { surface: "quiet", meaningZh: "安静的", ipa: "ˈkwaɪət" },
  { surface: "put", meaningZh: "放置", ipa: "pʊt" },
  { surface: "away", meaningZh: "离开；收好", ipa: "əˈweɪ" },
  { surface: "other", meaningZh: "其他的", ipa: "ˈʌðə" },
];

const teacherFailureCounts = new Map<string, number>();
const comparatorFailureCounts = new Map<string, number>();
const companionFailureCounts = new Map<string, number>();

function mockGlossaryFor(...texts: string[]) {
  const known = new Map(speakingGlossary.map((entry) => [entry.surface.toLowerCase(), entry]));
  return [...new Set(texts.flatMap((text) => text.match(/[A-Za-z]+(?:['’][A-Za-z]+)?/g) ?? []))]
    .map((surface) => known.get(surface.toLowerCase()) ?? { surface, meaningZh: `测试词项：${surface}`, ipa: "" });
}

/** 仅在 AI_PROVIDER=mock 的测试/E2E 环境使用。 */
export const runtimeAnswerMockResolver: MockAiResolver = (request) => {
  if (request.schemaName === "companion_response_chloe_v1") {
    const input = JSON.parse(request.input) as { latestUserMessage?: { text?: string }; scope?: { type?: string } };
    const text = input.latestUserMessage?.text?.trim() || "";
    if (text.includes("[mock:companion-always-fail]")) throw new Error("模拟 Chloe 服务持续不可用");
    if (text.includes("[mock:fail-once]")) {
      const count = companionFailureCounts.get(text) ?? 0;
      companionFailureCounts.set(text, count + 1);
      if (count < 3) throw new Error("模拟 Chloe 服务暂时不可用");
    }
    const messages = input.scope?.type === "question"
      ? [
          { text: "你的意思很清楚，而且这个做法很具体。", purpose: "natural_response" as const },
          { text: "更自然可以说：I stay focused by putting my phone in another room.", purpose: "natural_expression" as const },
          { text: "现在试着用自己的话再说一次，好吗？", purpose: "retry_request" as const },
        ]
      : [
          { text: text.includes("怎么") ? "可以。我们先把你真正想表达的意思说清楚，再选最自然的英文。" : "我明白你的意思了。我们先抓住这一轮最重要的一点。", purpose: "natural_response" as const },
          { text: input.scope?.type === "gap" ? "Try using the expression in one complete sentence." : "What would you like to say next?", purpose: "follow_up" as const },
        ];
    return {
      messages,
      glossary: mockGlossaryFor(text, ...messages.map((message) => message.text)),
    };
  }
  if (request.schemaName === "companion_memory_extractor_v1") {
    const input = JSON.parse(request.input) as { userMessages?: Array<{ id: string; text: string }>;messages?:Array<{id:string;text:string}> };
    const evidence = (input.messages??input.userMessages)?.find((message) => /喜欢咖啡|like coffee|不再喜欢咖啡/i.test(message.text));
    const changed = evidence && /不再喜欢咖啡/i.test(evidence.text);
    return { memories: evidence ? [{ memoryKey: "preferred_coffee", category: "preference", summary: changed ? "用户现在不喜欢咖啡。" : "用户喜欢咖啡。", confidence: 0.98, evidenceMessageIds: [evidence.id] }] : [] };
  }
  if (request.schemaName === "gap_retrieval_judge_v1") {
    const input = JSON.parse(request.input) as { userInput?: string; recommendedExpression?: string };
    const userInput = input.userInput?.trim() || "";
    if (userInput.includes("[mock:retrieval-fail]")) throw new Error("模拟提取判定服务不可用");
    const natural = /make (steady|consistent) progress/i.test(userInput);
    const contextDifference = /achieve progress/i.test(userInput);
    return {
      verdict: natural ? "natural_equivalent" : contextDifference ? "context_difference" : "incorrect",
      meaningPreserved: natural || contextDifference,
      naturalness: natural ? "natural" : contextDifference ? "understandable" : "unnatural",
      registerDifference: contextDifference ? "achieve progress 在当前日常语境中不如 make progress 自然。" : "",
      frequencyDifference: natural ? "与推荐表达频率接近。" : "推荐表达在日常口语中更常见。",
      explanationZh: natural ? "这个表达自然保留了原意。" : contextDifference ? "意思接近，但当前搭配和日常语境不够自然。" : "当前表达没有自然完成这个意思。",
      recommendedExpression: input.recommendedExpression || "make steady progress",
      proposedVariant: natural && userInput.toLowerCase() !== (input.recommendedExpression || "").toLowerCase()
        ? { expression: userInput, contextConstraintZh: "适合描述持续学习或工作进展" }
        : null,
      glossary: [],
    };
  }
  if (request.schemaName === "expression_variant_reviewer_v1") {
    const input = JSON.parse(request.input) as { candidateExpression?: string };
    const expression = input.candidateExpression?.trim() || "make consistent progress";
    const approved = /make consistent progress/i.test(expression);
    return {
      verdict: approved ? "approved" : "rejected",
      relation: approved ? "equivalent" : "not_equivalent",
      expression,
      register: "neutral",
      contextConstraintZh: approved ? "适合描述学习、工作或长期目标中的持续进展" : "",
      frequencyRelation: approved ? "similar" : "unknown",
      reasonZh: approved ? `“${expression}”在当前场景中自然保留了持续取得进步的意思。` : `“${expression}”不能稳定表达本次中文意图。`,
      canUseForLocalMatch: approved,
    };
  }
  if (request.schemaName === "answer_transform_v1") {
    return {
      revisedEnglish: sentence,
      translationZh: sentenceZh,
      changes: [{ type: "gap", original: "我会把手机放到另一个房间", revised: "putting my phone in another room", reasonZh: "把中文表达缺口转为自然口语英文。" }],
      gaps: [{ originalZh: "把手机放到另一个房间", recommendedEnglish: "put my phone in another room" }],
      sentences: [{ textEn: sentence, textZh: sentenceZh }],
    };
  }
  if (request.schemaName === "personal_chunk_generator_v1") return { candidates: [candidate] };
  if (request.schemaName === "personal_chunk_reviewer_v1") {
    return { items: [{ sentenceIndex: 0, canonicalChunk: "stay focused", verdict: "approved", reason: "边界自然、含义准确且可直接复用。", candidate }] };
  }
  if (request.schemaName === "speaking_hint_v1") {
    return {
      aiChineseIdea: "我通常会把手机放到另一个房间，这样学习时更容易保持专注。",
      keywords: ["focus", "phone", "distraction", "quiet"],
      chunks: [{ text: "stay focused", meaningZh: "保持专注" }, { text: "put my phone away", meaningZh: "把手机收起来" }],
      fullAnswer: sentence,
      glossary: speakingGlossary,
    };
  }
  if (request.schemaName === "speaking_teacher_v1") {
    const input = JSON.parse(request.input) as { latestUserMessage?: { text?: string }; deliveryAttempt?: number };
    const latestText = input.latestUserMessage?.text ?? "";
    if (latestText.includes("[mock:fail-once]")) {
      const count = teacherFailureCounts.get(latestText) ?? 0;
      teacherFailureCounts.set(latestText, count + 1);
      if (count < 3) throw new Error("模拟老师暂时不可用");
    }
    const teacherMessages = [
      { text: "你的意思很清楚，而且这个做法很具体。", purpose: "natural_response" },
      { text: "更自然可以说：I stay focused by putting my phone in another room.", purpose: "natural_expression" },
      { text: "现在试着用自己的话再说一次，好吗？", purpose: "retry_request" },
    ];
    const visibleEnglish = [latestText, ...teacherMessages.map((message) => message.text)].join(" ");
    const words = [...new Set((visibleEnglish.match(/[A-Za-z]+(?:['’][A-Za-z]+)?/g) ?? []).map((word) => word.toLowerCase()))];
    const known = new Map(speakingGlossary.map((entry) => [entry.surface.toLowerCase(), entry]));
    return {
      messages: teacherMessages,
      retryRequested: true,
      conversationComplete: false,
      glossary: words.map((word) => known.get(word) ?? { surface: word, meaningZh: "本轮口语中的英文词", ipa: "" }),
    };
  }
  if (["speaking_gap_generator_v1", "speaking_gap_generator_v2"].includes(request.schemaName)) {
    const input = JSON.parse(request.input) as { rawMessages?: Array<{ text?: string }> };
    const evidenceText = input.rawMessages?.findLast((message) => Boolean(message.text?.trim()))?.text?.trim() ?? "I stay focused.";
    return {
      candidates: [{
        key: "focus_expression_gap",
        gapType: "lexical_gap",
        evidenceText,
        intentZh: "说明自己如何在学习时保持专注",
        recommendedExpression: "stay focused by putting my phone in another room",
        explanationZh: "用户已经表达了具体做法，但需要把保持专注和做法连接成更自然、可复用的英语表达。",
        confidence: 0.94,
        impactLevel: "high",
        learningFit: true,
      }],
    };
  }
  if (["speaking_gap_reviewer_v1", "speaking_gap_reviewer_v2"].includes(request.schemaName)) {
    const input = JSON.parse(request.input) as { candidates?: Array<Record<string, unknown>> };
    return {
      items: (input.candidates ?? []).map((item) => ({
        key: item.key,
        verdict: "approved",
        reason: `证据“${String(item.evidenceText).slice(0, 48)}”来自本轮用户原话，推荐表达保留原意且可跨场景复用。`,
        candidate: item,
      })),
    };
  }
  if (request.schemaName === "speaking_reattempt_comparator_v1") {
    const input = JSON.parse(request.input) as {
      currentGaps?: Array<{ id: string; clusterId: string | null }>;
      previousGaps?: Array<{ id: string; clusterId: string | null }>;
      rawText?: string;
    };
    if (input.rawText?.includes("[mock:comparator-fail-once]")) {
      const count = comparatorFailureCounts.get(input.rawText) ?? 0;
      comparatorFailureCounts.set(input.rawText, count + 1);
      if (count < 3) throw new Error("模拟重答比较器暂时不可用");
    }
    return {
      items: (input.currentGaps ?? []).map((gap) => {
        const previous = (input.previousGaps ?? []).find((item) => item.clusterId && item.clusterId === gap.clusterId);
        return {
          subjectGapId: gap.id,
          comparison: previous ? "repeated" : "new",
          relatedGapId: previous?.id ?? null,
          reason: previous ? "本轮再次出现了同一表达缺口，需要继续学习和复习。" : "这是该题当前可确认的新表达缺口。",
        };
      }),
    };
  }
  if (request.schemaName === "speaking_learning_material_generator_v1") {
    const input = JSON.parse(request.input) as { approvedGaps?: Array<{ id: string }> };
    const commonUsage = {
      settingZh: "晚上在图书馆讨论如何避免手机干扰",
      relationshipZh: "一起备考的朋友",
      purposeZh: "分享让自己专注学习的具体办法",
      register: "casual",
      accent: "en-US",
      lines: [
        { speaker: "Maya", textEn: "How do you avoid distractions while studying?", textZh: "你学习时怎么避免干扰？", target: false },
        { speaker: "Leo", textEn: sentence, textZh: sentenceZh, target: true },
      ],
    } as const;
    const questionRepair = {
      settingZh: "IELTS Speaking Part 1 回答现场",
      relationshipZh: "考官与考生",
      purposeZh: "具体说明自己保持专注的方法",
      register: "neutral",
      accent: "en-US",
      lines: [
        { speaker: "Examiner", textEn: "How do you stay focused while studying?", textZh: "学习时你怎样保持专注？", target: false },
        { speaker: "Candidate", textEn: sentence, textZh: sentenceZh, target: true },
      ],
    } as const;
    const visibleEnglish = [sentence, ...commonUsage.lines.map((line) => line.textEn), ...questionRepair.lines.map((line) => line.textEn)].join(" ");
    const words = [...new Set((visibleEnglish.match(/[A-Za-z]+(?:['’][A-Za-z]+)?/g) ?? []).map((word) => word.toLowerCase()))];
    const known = new Map(speakingGlossary.map((entry) => [entry.surface.toLowerCase(), entry]));
    const glossary = words.map((word) => known.get(word) ?? { surface: word, meaningZh: "本轮学习语境中的英文词", ipa: "" });
    return {
      materials: (input.approvedGaps ?? []).map((gap) => ({ gapId: gap.id, chunk: candidate, commonUsage, questionRepair, glossary })),
    };
  }
  if (request.schemaName === "speaking_learning_material_reviewer_v1") {
    const input = JSON.parse(request.input) as { materials?: Array<Record<string, unknown>> };
    return {
      items: (input.materials ?? []).map((material) => ({
        gapId: material.gapId,
        verdict: "approved",
        reason: "Chunk 直接修复当前表达缺口；日常语境与原题修复语境用途不同、目标行明确且美式英语自然。",
        material,
      })),
    };
  }
  if (request.schemaName === "speaking_feedback_v1") {
    return {
      summaryZh: "你的意思清楚，但手机相关表达可以更自然。",
      correctedAnswer: sentence,
      correctedTranslationZh: sentenceZh,
      correctedSentences: [{ textEn: sentence, textZh: sentenceZh }],
      items: [{
        originalSentence: "I put my phone other room.",
        problemType: "grammar",
        reasonZh: "缺少介词 in 和限定词 another，表达不完整。",
        recommendedSentence: sentence,
        gapExpression: "putting my phone in another room",
        gapMeaningZh: "把手机放到另一个房间",
      }],
      glossary: speakingGlossary,
    };
  }
  if (request.schemaName === "speaking_retry_v1") {
    const input = JSON.parse(request.input) as { retryText?: string };
    const passed = input.retryText?.toLowerCase().includes("putting my phone in another room") ?? false;
    return {
      passed,
      feedbackZh: passed ? "这次已经把介词和完整表达说对了。" : "再注意 in another room，并把整段表达连起来。",
      acceptedSentence: sentence,
    };
  }
  if (request.schemaName === "correction_gap_generator_v1") return { candidates: [correctionGapCandidate] };
  if (request.schemaName === "correction_gap_reviewer_v1") {
    return { items: [{ sentenceIndex: 0, canonicalChunk: correctionGapCandidate.canonicalChunk, verdict: "approved", reason: "来自实际纠错缺口，边界完整且可复用。", candidate: correctionGapCandidate }] };
  }
  if (request.schemaName === "speaking_attempt_analysis_v1" || request.schemaName === "speaking_practice_analysis_v1") {
    const input = JSON.parse(request.input) as {
      question?: { textEn?: string; textZh?: string; part?: number };
      mode?: "practice" | "exam_style";
      actualAnswer?: string;
      intendedMeaningZh?: string;
    };
    const answer = (input.actualAnswer ?? "").trim();
    const intention = (input.intendedMeaningZh ?? "").trim();
    const mode = input.mode ?? "practice";

    // Case 1: Missing hyphen (fourth year student)
    // Case 2: Natural alternative (I study computer science)
    // Case 6: ASR capitalization (china university of petroleum)
    // Case 7: AI reference is stylistically more sophisticated
    const isHyphenOnly = /fourth year student/i.test(answer) && !answer.includes("井盖");
    const isNaturalAlternativeOnly = /I study computer science/i.test(answer) && !answer.includes("井盖");
    const isCapitalizationOnly = /china university of petroleum/i.test(answer) && !answer.includes("井盖") && !intention.includes("化学");

    if (isHyphenOnly || isNaturalAlternativeOnly || isCapitalizationOnly) {
      return {
        naturalVersion: answer.length > 0 ? (isHyphenOnly ? "I'm a fourth-year student." : isNaturalAlternativeOnly ? "I'm majoring in computer science." : "I study at China University of Petroleum.") : "I'm a student.",
        gaps: [],
        corrections: [],
        learningItems: [],
        learningMaterials: [
          {
            chineseChunk: "大四学生",
            englishChunk: "fourth-year student",
            acceptableVariants: ["fourth-year student", "fourth year student"],
            yourChineseSentence: "我是大四学生。",
            naturalEnglishSentence: "I'm a fourth-year student.",
          },
        ],
        gapCount: 0,
        clozeItems: [],
        examFeedback: mode === "exam_style" ? {
          transcriptBasedNotice: "本反馈基于答题文本与发音转写，未对实际语音声学指标进行评分。",
          lexicalResource: "用词自然恰当，表达清晰。",
          grammaticalRange: "语法控制良好，句式自然。",
          coherence: "逻辑清晰，直接回答了问题。",
          paraphrasing: "交际自然流畅。",
          strengths: ["表达地道", "意图明确"],
          weaknesses: [],
          approximateBand: "7.0",
        } : null,
      };
    }

    // Case 4: Unexpressed intentions (e.g. User says "I'm a student." but intention has major, chemistry, switch)
    if (answer.toLowerCase() === "i'm a student." && intention.includes("转") && intention.includes("化学")) {
      const gaps = [
        {
          key: "gap_switch_majors",
          intentZh: "从化学转到计算机专业",
          targetEnglish: "switch majors",
          gapType: "unexpressed_intention" as const,
          evidence: "[未在英文中表达]",
          explanationZh: "中文意图中明确表达了从化学转到计算机，但英文回答中完全遗漏了这一核心经历。",
        },
        {
          key: "gap_fourth_year",
          intentZh: "大四学生",
          targetEnglish: "fourth-year student",
          gapType: "unexpressed_intention" as const,
          evidence: "[未在英文中表达]",
          explanationZh: "中文表明是大四学生，英文仅泛化表达了 student。",
        },
      ];
      return {
        naturalVersion: "I'm a fourth-year student majoring in computer science in Qingdao. I switched majors from chemistry to computer science.",
        gaps,
        corrections: [{
          original: "I'm a student.",
          corrected: "I'm a fourth-year student majoring in computer science...",
          reasonZh: "英文未充分展开意图中的年级与转专业经历。",
        }],
        learningItems: [
          {
            canonicalKey: "switch majors",
            targetEnglish: "switch majors",
            intentionZh: "转专业",
            itemType: "lexical_chunk" as const,
            example: "I decided to switch majors in my sophomore year.",
          },
          {
            canonicalKey: "fourth year student",
            targetEnglish: "fourth-year student",
            intentionZh: "大四学生",
            itemType: "collocation" as const,
            example: "As a fourth-year student, I'm preparing to graduate.",
          },
        ],
        learningMaterials: [
          {
            chineseChunk: "大四学生",
            englishChunk: "fourth-year student",
            acceptableVariants: ["fourth-year student", "senior student", "final-year student"],
            yourChineseSentence: "我是在青岛读计算机的大四学生。",
            naturalEnglishSentence: "I'm a fourth-year student majoring in computer science in Qingdao.",
          },
          {
            chineseChunk: "从化学转到计算机专业",
            englishChunk: "switch majors",
            acceptableVariants: ["switched majors"],
            yourChineseSentence: "我之前其实学化学，后来转专业到了计算机。",
            naturalEnglishSentence: "I switched majors from chemistry to computer science.",
          },
        ],
        gapCount: 2,
        clozeItems: [
          {
            gapKey: "gap_switch_majors",
            originalSentence: "I switched majors from chemistry to computer science.",
            clozeSentence: "I actually started out in chemistry, but later ________（转专业） to CS.",
            answer: "switched",
            hintZh: "转专业",
            acceptableAnswers: ["switched", "switched majors"],
          },
        ],
        examFeedback: mode === "exam_style" ? {
          transcriptBasedNotice: "本反馈基于答题文本与发音转写，未对实际语音声学指标进行评分。",
          lexicalResource: "词汇过于简略，未充分展现话题词汇。",
          grammaticalRange: "仅使用单一简单句。",
          coherence: "内容展开不足。",
          paraphrasing: "无释义展开。",
          strengths: ["回答切题"],
          weaknesses: ["未表达核心意图", "信息量过少"],
          approximateBand: "5.0",
        } : null,
      };
    }

    // Case 5: Paraphrasing in exam-style ("round metal thing covering a hole in the road")
    if (/round metal thing covering a hole in the road/i.test(answer)) {
      const gaps = [{
        key: "gap_manhole_cover",
        intentZh: "井盖",
        targetEnglish: "manhole cover",
        gapType: "lexical_gap" as const,
        evidence: "round metal thing covering a hole in the road",
        explanationZh: "你通过生动的描述成功进行了释义（Paraphrasing），地道的固定称呼是 manhole cover。",
      }];
      return {
        naturalVersion: "I couldn't recall the specific term, but I saw a manhole cover on the road.",
        gaps,
        corrections: [],
        learningItems: [{
          canonicalKey: "manhole cover",
          targetEnglish: "manhole cover",
          intentionZh: "井盖",
          itemType: "lexical_chunk" as const,
          example: "Be careful not to step on that loose manhole cover.",
        }],
        learningMaterials: [
          {
            chineseChunk: "井盖",
            englishChunk: "manhole cover",
            acceptableVariants: ["manhole cover", "manhole covers"],
            yourChineseSentence: "我在马路上看到一个井盖。",
            naturalEnglishSentence: "I couldn't recall the specific term, but I saw a manhole cover on the road.",
          },
        ],
        gapCount: 1,
        clozeItems: [{
          gapKey: "gap_manhole_cover",
          originalSentence: "I saw a manhole cover on the road.",
          clozeSentence: "I saw a ________（井盖） on the road.",
          answer: "manhole cover",
          hintZh: "井盖",
          acceptableAnswers: ["manhole cover"],
        }],
        examFeedback: {
          transcriptBasedNotice: "本反馈基于答题文本与发音转写，未对实际语音声学指标进行评分。",
          lexicalResource: "尽管未能直接提取专有名词，但展现了极佳的口语释义与迂回表达能力（Circumlocution），这是高水平考生的关键交际技能。",
          grammaticalRange: "从句结构清晰，语法控制稳定。",
          coherence: "交际意图完全传达。",
          paraphrasing: "优秀的英语释义能力，值得肯定！",
          strengths: ["成功的 Paraphrasing", "交际连续性强"],
          weaknesses: ["可积累更精准的市政设施词汇"],
          approximateBand: "6.5",
        },
      };
    }

    // Explicit Chinese gap (Case 3 / Case 8): e.g. "井盖"
    if (answer.includes("井盖") || intention.includes("井盖")) {
      const gaps = [{
        key: "gap_manhole_cover",
        intentZh: "井盖",
        targetEnglish: "manhole cover",
        gapType: "lexical_gap" as const,
        evidence: "井盖",
        explanationZh: "“井盖”的地道美式/英式口语表达是 manhole cover。",
      }];
      return {
        naturalVersion: answer.replaceAll("井盖", "manhole cover"),
        gaps,
        corrections: [{
          original: "井盖",
          corrected: "manhole cover",
          reasonZh: "口语交流中遇到不会的词可用 manhole cover 表达井盖。",
        }],
        learningItems: [{
          canonicalKey: "manhole cover",
          targetEnglish: "manhole cover",
          intentionZh: "井盖",
          itemType: "lexical_chunk" as const,
          example: "I saw a manhole cover on the street.",
        }],
        learningMaterials: [
          {
            chineseChunk: "井盖",
            englishChunk: "manhole cover",
            acceptableVariants: ["manhole cover", "manhole covers"],
            yourChineseSentence: "我在路上看到了一个井盖。",
            naturalEnglishSentence: (answer.split(/(?<=[.?!])\s+/).find((sentence) => sentence.includes("井盖")) ?? answer).replaceAll("井盖", "manhole cover"),
          },
        ],
        gapCount: 1, // Distinct count is 1 even if occurs multiple times
        clozeItems: [{
          gapKey: "gap_manhole_cover",
          originalSentence: "I saw a manhole cover on the street.",
          clozeSentence: "I saw a ________（井盖） on the street.",
          answer: "manhole cover",
          hintZh: "井盖",
          acceptableAnswers: ["manhole cover"],
        }],
        examFeedback: mode === "exam_style" ? {
          transcriptBasedNotice: "本反馈基于答题文本与发音转写，未对实际语音声学指标进行评分。",
          lexicalResource: "出现中文词汇，建议多积累日常街景与生活设施表达。",
          grammaticalRange: "基础句式成立。",
          coherence: "语义清晰。",
          paraphrasing: "遇到未知词汇可尝试用英文描述其外观或功能。",
          strengths: ["真实表意意图明确"],
          weaknesses: ["存在中文夹杂"],
          approximateBand: "5.5",
        } : null,
      };
    }

    // Default clean response
    return {
      naturalVersion: answer || "I'm focusing on my studies and preparing for the future.",
      gaps: [],
      corrections: [],
      learningItems: [],
      learningMaterials: [
        {
          chineseChunk: "专注于学习",
          englishChunk: "focus on my studies",
          acceptableVariants: ["focus on my studies", "focusing on my studies", "concentrate on studying"],
          yourChineseSentence: "我正专注于我的学习。",
          naturalEnglishSentence: "I'm focusing on my studies.",
        },
        {
          chineseChunk: "为未来做准备",
          englishChunk: "prepare for the future",
          acceptableVariants: ["prepare for the future", "preparing for the future", "get ready for the future"],
          yourChineseSentence: "我正在为未来做准备。",
          naturalEnglishSentence: "I'm preparing for the future.",
        },
      ],
      gapCount: 0,
      clozeItems: [],
      examFeedback: mode === "exam_style" ? {
        transcriptBasedNotice: "本反馈基于答题文本与发音转写，未对实际语音声学指标进行评分。",
        lexicalResource: "用词得体，表达自然。",
        grammaticalRange: "句式控制良好。",
        coherence: "思路连贯。",
        paraphrasing: "交流顺畅。",
        strengths: ["整体自然流畅"],
        weaknesses: [],
        approximateBand: "6.5",
      } : null,
    };
  }

  if (request.schemaName === "speaking_translation_eval_v1") {
    const input = JSON.parse(request.input) as {
      intendedMeaningZh?: string;
      naturalReference?: string;
      userAttemptEnglish?: string;
    };
    const userText = (input.userAttemptEnglish ?? "").trim();
    // Accept valid natural alternatives semantically
    const passed = userText.length > 0 && !/[\u4e00-\u9fa5]/.test(userText);
    return {
      passed,
      feedbackZh: passed
        ? "表达自然准确，成功传达了核心意图！英语口语鼓励多样化、地道的个人表达，无需逐字机械对照参考答案。"
        : "仍包含未翻译的中文或表达未完成，请尝试用完整的英文说出你的想法。",
      communicatedIntention: passed,
      naturalness: passed ? "natural" : "incomplete",
      suggestedAlternative: input.naturalReference ?? "",
    };
  }

  if (request.schemaName === "free_talk_response_v1") {
    const input = JSON.parse(request.input) as {
      mode?: "relaxed" | "strict";
      userText?: string;
      previousTeachingState?: string | null;
      previousTargetRepetition?: string | null;
      recentHistory?: Array<{ role: string; text: string }>;
      knownLearningItems?: Array<{ canonicalKey: string; targetEnglish: string; intentionZh: string }>;
    };
    const mode = input.mode ?? "relaxed";
    const text = (input.userText ?? "").trim();

    // Helper to produce mock user correction based on input
    const userCorrection = text.includes("井盖")
      ? {
          natural: false,
          issue: "夹杂了中文词汇“井盖”",
          betterExpression: text.replaceAll("井盖", "manhole cover"),
          explanationZh: "口语中遇到不会的市政设施词汇，地道说法是 manhole cover。",
        }
      : /very like|play computer game\b/i.test(text)
        ? {
            natural: false,
            issue: "“very like”是中式直译，动词搭配应为 really like",
            betterExpression: text.replace(/very like/i, "really like"),
            explanationZh: "英语中表达非常喜欢常说 really like 或 enjoy ... very much。",
          }
        : { natural: true };

    // Check if user is repeating in Strict Mode
    if (input.previousTeachingState === "repetition_requested") {
      const repeated = /manhole cover/i.test(text) || text.length > 3;
      return {
        reply: repeated
          ? "Spot on! That sounded totally natural. So what happened next? Did anyone else notice it?"
          : "Almost! Try saying: \"manhole cover\". Anyway, what happened next?",
        translationZh: repeated
          ? "太棒了！听起来非常自然地道。后来又发生了什么？还有其他人注意到吗？"
          : "很接近了！试着说：\"manhole cover\"。话说回来，后来又发生了什么？",
        userCorrection,
        teachingState: "repetition_confirmed",
        targetRepetition: null,
        gaps: [],
        learningItems: [],
        gapCount: 0,
        resurfacedItemKey: null,
      };
    }

    // Check for "井盖" in text
    if (text.includes("井盖")) {
      const manholeGap = {
        key: "gap_manhole_cover",
        intentZh: "井盖",
        targetEnglish: "manhole cover",
        gapType: "lexical_gap" as const,
        evidence: "井盖",
        explanationZh: "“井盖”在美式英语中常用 manhole cover。",
      };
      const manholeItem = {
        canonicalKey: "manhole cover",
        targetEnglish: "manhole cover",
        intentionZh: "井盖",
        itemType: "lexical_chunk" as const,
        example: "I saw an open manhole cover on the road.",
      };

      if (mode === "strict") {
        return {
          reply: "“井盖” in English is **manhole cover**. You could say: \"I saw a manhole cover on the street.\" Try saying that once!",
          translationZh: "“井盖”在英语里是 manhole cover。你可以说：\"I saw a manhole cover on the street.\" 试着说一遍吧！",
          userCorrection,
          teachingState: "repetition_requested",
          targetRepetition: "I saw a manhole cover on the street.",
          gaps: [manholeGap],
          learningItems: [manholeItem],
          gapCount: 1,
          resurfacedItemKey: null,
        };
      } else {
        // Relaxed mode: natural recast without mandatory repetition
        return {
          reply: "Oh, you saw a **manhole cover** on the street? Was it open or loose? That sounds pretty dangerous!",
          translationZh: "天哪，你在街上看到了一个井盖？它是开着的还是松了？听起来挺危险的！",
          userCorrection,
          teachingState: null,
          targetRepetition: null,
          gaps: [manholeGap],
          learningItems: [manholeItem],
          gapCount: 1,
          resurfacedItemKey: null,
        };
      }
    }

    // Handle "too many problems" test case (5 genuine gaps in one message)
    if (text.includes("[mock:five-gaps]") || (text.includes("实习") && text.includes("转专业") && text.includes("毕业") && text.includes("租房") && text.includes("兼职"))) {
      // Backend preserves multiple gaps, but foreground focuses on 1-2 items
      const gaps = [
        { key: "gap_internship", intentZh: "找实习", targetEnglish: "look for an internship", gapType: "lexical_gap" as const, evidence: "实习", explanationZh: "look for an internship" },
        { key: "gap_switch_majors", intentZh: "转专业", targetEnglish: "switch majors", gapType: "lexical_gap" as const, evidence: "转专业", explanationZh: "switch majors" },
        { key: "gap_graduate", intentZh: "明年毕业", targetEnglish: "graduate next year", gapType: "lexical_gap" as const, evidence: "毕业", explanationZh: "graduate next year" },
        { key: "gap_rent_apartment", intentZh: "租房", targetEnglish: "rent an apartment", gapType: "lexical_gap" as const, evidence: "租房", explanationZh: "rent an apartment" },
        { key: "gap_part_time_job", intentZh: "做兼职", targetEnglish: "work a part-time job", gapType: "lexical_gap" as const, evidence: "兼职", explanationZh: "work a part-time job" },
      ];
      const learningItems = gaps.map((g) => ({
        canonicalKey: g.targetEnglish,
        targetEnglish: g.targetEnglish,
        intentionZh: g.intentZh,
        itemType: "lexical_chunk" as const,
        example: `I plan to ${g.targetEnglish}.`,
      }));

      return {
        reply: mode === "strict"
          ? "You have a lot going on! Let's focus on the most important one first: for “找实习”, we say **look for an internship**. Try saying: \"I'm looking for an internship.\""
          : "Wow, you have a lot on your plate! It sounds like **looking for an internship** and **switching majors** take up most of your energy. How are you handling it all?",
        translationZh: mode === "strict"
          ? "你手头的事情真多！我们先聚焦最重要的一个：对于“找实习”，我们说 look for an internship。试着说一次吧！"
          : "哇，你面临的事情确实不少！看起来找实习和转专业占用了你大部分精力。你目前应对得怎么样？",
        userCorrection,
        teachingState: mode === "strict" ? "repetition_requested" : null,
        targetRepetition: mode === "strict" ? "I'm looking for an internship." : null,
        gaps,
        learningItems,
        gapCount: 5,
        resurfacedItemKey: null,
      };
    }

    // Default conversational reply with optional spaced resurfacing
    const resurfaced = input.knownLearningItems?.[0];
    const resurfacedReply = resurfaced
      ? `That's interesting! By the way, speaking of your goals, are you still planning to ${resurfaced.targetEnglish}?`
      : "That sounds fascinating! Tell me more about that. How did you feel about the whole experience?";

    return {
      reply: resurfacedReply,
      translationZh: resurfaced
        ? `很有意思！顺便问一下，说到你的目标，你目前还计划继续 ${resurfaced.targetEnglish} 吗？`
        : "听起来太有意思了！多跟我讲讲吧。你对整个经历感觉如何？",
      userCorrection,
      teachingState: null,
      targetRepetition: null,
      gaps: [],
      learningItems: [],
      gapCount: 0,
      resurfacedItemKey: resurfaced?.canonicalKey ?? null,
    };
  }

  throw new Error(`未知 Runtime Mock Schema：${request.schemaName}`);
};
