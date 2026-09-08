/**
 * 维度语块库（两层内容工程）：
 *  - CLASS_CHUNKS: 通用维度语块（按语义类），覆盖几乎所有题目都出现的通用维度。
 *  - DIM_CLASS_MAP: blueprint dimId → 语义类的映射规则（关键词匹配）。
 *  - TOPIC_POOLS: 话题专属语块池（按话题名），覆盖话题特有维度。
 * 所有 chunk 均为人工策划的真实口语表达；由确定性代码按题目维度装配。
 * 版本: dimlib-v1 —— 修改必须跑 Golden 回归并更新 content_version。
 */

export interface LibChunk {
  display: string;
  meaningZh: string;
  unitType: "collocation" | "lexical_chunk" | "phrasal_verb" | "sentence_frame" | "construction" | "functional_expression" | "idiom";
  difficulty: "basic" | "intermediate" | "advanced";
  exampleEn: string;
  exampleZh?: string;
  pattern?: string;
  variants?: string[];
}

export type DimClass =
  | "reason" | "like" | "dislike" | "attitude" | "comparison" | "frequency"
  | "change" | "future" | "past" | "feeling" | "evaluation" | "example"
  | "preference" | "people" | "place" | "time" | "cost" | "influence"
  | "difficulty" | "method" | "benefit" | "plan" | "memory"
  | "situations" | "balance" | "advice" | "instance" | "atmosphere" | "lesson" | "technology";

/** 通用维度语块库（每个类 3-5 条，全部为真实高频口语表达） */
export const CLASS_CHUNKS: Record<DimClass, LibChunk[]> = {
  reason: [
    { display: "The main reason is that...", meaningZh: "主要原因是…", unitType: "sentence_frame", difficulty: "basic", exampleEn: "The main reason is that it saves time.", exampleZh: "主要原因是省时间。" },
    { display: "because it helps me...", meaningZh: "因为它能帮我…", unitType: "sentence_frame", difficulty: "basic", exampleEn: "I like it because it helps me relax.", exampleZh: "我喜欢它因为它帮我放松。" },
    { display: "That's why...", meaningZh: "这就是为什么…", unitType: "sentence_frame", difficulty: "basic", exampleEn: "That's why I stick to it.", exampleZh: "所以我一直坚持。" },
    { display: "partly because...", meaningZh: "部分原因是…", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "Partly because I grew up with it.", exampleZh: "部分因为我从小接触它。" },
  ],
  like: [
    { display: "be really into...", meaningZh: "非常喜欢…", unitType: "collocation", difficulty: "intermediate", exampleEn: "I'm really into photography.", exampleZh: "我特别喜欢摄影。" },
    { display: "be a big fan of...", meaningZh: "是…的忠实爱好者", unitType: "collocation", difficulty: "basic", exampleEn: "I'm a big fan of outdoor activities.", exampleZh: "我超爱户外活动。" },
    { display: "What I like most about ... is...", meaningZh: "我最喜欢…的地方是…", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "What I like most about it is the freedom.", exampleZh: "我最喜欢的是那种自由感。" },
    { display: "It never gets old.", meaningZh: "永远不会腻", unitType: "lexical_chunk", difficulty: "advanced", exampleEn: "I watch it every year — it never gets old.", exampleZh: "我每年都看——永远不腻。" },
  ],
  dislike: [
    { display: "not a big fan of...", meaningZh: "不太喜欢…", unitType: "collocation", difficulty: "basic", exampleEn: "I'm not a big fan of crowded places.", exampleZh: "我不太喜欢人多的地方。" },
    { display: "What annoys me is...", meaningZh: "让我烦的是…", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "What annoys me is the endless ads.", exampleZh: "让我烦的是没完没了的广告。" },
    { display: "get tired of...", meaningZh: "对…感到厌倦", unitType: "collocation", difficulty: "intermediate", exampleEn: "I get tired of doing the same thing every day.", exampleZh: "每天做同样的事我会腻。" },
  ],
  attitude: [
    { display: "It depends on...", meaningZh: "这取决于…", unitType: "functional_expression", difficulty: "basic", exampleEn: "It depends on my mood, really.", exampleZh: "真的取决于我的心情。" },
    { display: "To be honest, ...", meaningZh: "说实话…", unitType: "functional_expression", difficulty: "basic", exampleEn: "To be honest, I rarely think about it.", exampleZh: "说实话我很少想这个。" },
    { display: "I'd say...", meaningZh: "我觉得…", unitType: "functional_expression", difficulty: "basic", exampleEn: "I'd say it's becoming more popular.", exampleZh: "我觉得它越来越流行了。" },
    { display: "I have mixed feelings about...", meaningZh: "对…心情复杂", unitType: "collocation", difficulty: "advanced", exampleEn: "I have mixed feelings about working from home.", exampleZh: "对居家办公我心情挺复杂。" },
  ],
  comparison: [
    { display: "Compared to..., ...", meaningZh: "与…相比…", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "Compared to ten years ago, everything is faster.", exampleZh: "和十年前比，一切都快了。" },
    { display: "A is more... than B", meaningZh: "A 比 B 更…", unitType: "construction", difficulty: "basic", exampleEn: "Online shopping is more convenient than in-store shopping.", exampleZh: "网购比实体店购物方便。" },
    { display: "..., whereas...", meaningZh: "…然而…", unitType: "construction", difficulty: "advanced", exampleEn: "Young people text, whereas older people prefer calls.", exampleZh: "年轻人发信息，年长者更喜欢打电话。" },
  ],
  frequency: [
    { display: "now and then", meaningZh: "时不时", unitType: "functional_expression", difficulty: "basic", exampleEn: "I go there now and then.", exampleZh: "我时不时去一次。" },
    { display: "on a daily basis", meaningZh: "每天都", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "I check the news on a daily basis.", exampleZh: "我每天都看新闻。" },
    { display: "whenever I get the chance", meaningZh: "一有机会就", unitType: "lexical_chunk", difficulty: "intermediate", exampleEn: "I travel whenever I get the chance.", exampleZh: "一有机会我就去旅行。" },
    { display: "every now and then", meaningZh: "偶尔", unitType: "functional_expression", difficulty: "basic", exampleEn: "Every now and then we meet up.", exampleZh: "我们偶尔聚一聚。" },
  ],
  change: [
    { display: "go through huge changes", meaningZh: "经历巨大变化", unitType: "collocation", difficulty: "intermediate", exampleEn: "My hometown has gone through huge changes.", exampleZh: "我家乡经历了巨大变化。" },
    { display: "used to..., but now...", meaningZh: "过去…但现在…", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "I used to hate it, but now I love it.", exampleZh: "我以前讨厌它，但现在很喜欢。" },
    { display: "It's not what it used to be.", meaningZh: "它已经不是从前的样子了", unitType: "lexical_chunk", difficulty: "intermediate", exampleEn: "The neighbourhood isn't what it used to be.", exampleZh: "这个街区已经不复从前了。" },
    { display: "more and more people...", meaningZh: "越来越多的人…", unitType: "sentence_frame", difficulty: "basic", exampleEn: "More and more people work from home.", exampleZh: "越来越多的人在家办公。" },
  ],
  future: [
    { display: "in the near future", meaningZh: "在不久的将来", unitType: "functional_expression", difficulty: "basic", exampleEn: "Things will change in the near future.", exampleZh: "不久的将来 things 会变。" },
    { display: "I'm planning to...", meaningZh: "我打算…", unitType: "sentence_frame", difficulty: "basic", exampleEn: "I'm planning to travel next year.", exampleZh: "我打算明年去旅行。" },
    { display: "I'm hoping to...", meaningZh: "我希望…", unitType: "sentence_frame", difficulty: "basic", exampleEn: "I'm hoping to study abroad.", exampleZh: "我希望出国学习。" },
    { display: "down the road", meaningZh: "将来、日后", unitType: "functional_expression", difficulty: "advanced", exampleEn: "Maybe I'll settle down down the road.", exampleZh: "也许以后我会安定下来。" },
  ],
  past: [
    { display: "back then", meaningZh: "那时候", unitType: "functional_expression", difficulty: "basic", exampleEn: "Back then, we didn't have smartphones.", exampleZh: "那时候我们没有智能手机。" },
    { display: "When I was a kid, ...", meaningZh: "我小时候…", unitType: "sentence_frame", difficulty: "basic", exampleEn: "When I was a kid, I played outside all day.", exampleZh: "小时候我整天在外面玩。" },
    { display: "I remember...ing", meaningZh: "我记得曾…", unitType: "construction", difficulty: "intermediate", exampleEn: "I remember visiting it every summer.", exampleZh: "我记得每年夏天都去。" },
  ],
  feeling: [
    { display: "It makes my day.", meaningZh: "它让我一天心情都好", unitType: "lexical_chunk", difficulty: "intermediate", exampleEn: "A small compliment makes my day.", exampleZh: "一句小夸奖能让我开心一整天。" },
    { display: "I feel like...", meaningZh: "我感觉…", unitType: "functional_expression", difficulty: "basic", exampleEn: "I feel like it's getting better.", exampleZh: "我感觉它正在变好。" },
    { display: "over the moon", meaningZh: "开心极了", unitType: "idiom", difficulty: "advanced", exampleEn: "I was over the moon when I heard the news.", exampleZh: "听到消息我开心极了。" },
    { display: "It can be a bit overwhelming.", meaningZh: "有时会有点让人喘不过气", unitType: "lexical_chunk", difficulty: "advanced", exampleEn: "Big cities can be a bit overwhelming.", exampleZh: "大城市有时让人喘不过气。" },
  ],
  evaluation: [
    { display: "pros and cons", meaningZh: "利与弊", unitType: "collocation", difficulty: "intermediate", exampleEn: "Everything has its pros and cons.", exampleZh: "凡事都有利弊。" },
    { display: "on the plus side", meaningZh: "好的一面是", unitType: "functional_expression", difficulty: "intermediate", exampleEn: "On the plus side, it's cheaper.", exampleZh: "好的一面是更便宜。" },
    { display: "the downside is...", meaningZh: "坏处是…", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "The downside is that it takes longer.", exampleZh: "坏处是更耗时。" },
    { display: "play a big role in...", meaningZh: "在…中起重要作用", unitType: "collocation", difficulty: "intermediate", exampleEn: "Technology plays a big role in education.", exampleZh: "技术在教育中作用巨大。" },
  ],
  example: [
    { display: "For example, ...", meaningZh: "例如…", unitType: "functional_expression", difficulty: "basic", exampleEn: "For example, my cousin learns online.", exampleZh: "例如我表弟在网上学。" },
    { display: "like... for instance", meaningZh: "比如…", unitType: "functional_expression", difficulty: "basic", exampleEn: "Some apps, like Duolingo for instance, are free.", exampleZh: "有些应用比如多邻国是免费的。" },
    { display: "Take ... for example.", meaningZh: "拿…来说", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "Take my neighbour for example — he's seventy and still jogs.", exampleZh: "拿我邻居来说——他七十岁还在跑步。" },
  ],
  preference: [
    { display: "I'd rather... than...", meaningZh: "我宁愿…而不…", unitType: "construction", difficulty: "intermediate", exampleEn: "I'd rather stay home than go out.", exampleZh: "我宁愿待在家也不出门。" },
    { display: "I lean towards...", meaningZh: "我更倾向…", unitType: "collocation", difficulty: "advanced", exampleEn: "I lean towards quieter hobbies.", exampleZh: "我更偏好安静的爱好。" },
    { display: "given the choice, I'd...", meaningZh: "如果让我选，我会…", unitType: "sentence_frame", difficulty: "advanced", exampleEn: "Given the choice, I'd work from home.", exampleZh: "如果让我选，我会居家办公。" },
  ],
  people: [
    { display: "get along well with...", meaningZh: "与…相处融洽", unitType: "collocation", difficulty: "intermediate", exampleEn: "I get along well with my neighbours.", exampleZh: "我和邻居相处融洽。" },
    { display: "a people person", meaningZh: "善于交际的人", unitType: "idiom", difficulty: "advanced", exampleEn: "My mum is a real people person.", exampleZh: "我妈特别善于交际。" },
    { display: "look up to someone", meaningZh: "尊敬某人", unitType: "phrasal_verb", difficulty: "intermediate", exampleEn: "I look up to my first boss.", exampleZh: "我很尊敬我的第一任老板。" },
  ],
  place: [
    { display: "a must-see / a must-visit", meaningZh: "必去之地", unitType: "collocation", difficulty: "intermediate", exampleEn: "The old town is a must-visit.", exampleZh: "老城区是必去之地。" },
    { display: "off the beaten track", meaningZh: "鲜有人至的", unitType: "idiom", difficulty: "advanced", exampleEn: "We found a café off the beaten track.", exampleZh: "我们找到一家很少有人知道的咖啡馆。" },
    { display: "right around the corner", meaningZh: "就在附近、拐角处", unitType: "collocation", difficulty: "intermediate", exampleEn: "There's a park right around the corner.", exampleZh: "拐角处就有一个公园。" },
  ],
  time: [
    { display: "kill time", meaningZh: "打发时间", unitType: "collocation", difficulty: "intermediate", exampleEn: "I scroll my phone to kill time.", exampleZh: "我刷手机打发时间。" },
    { display: "It takes ages.", meaningZh: "要花很长时间", unitType: "lexical_chunk", difficulty: "intermediate", exampleEn: "The commute takes ages.", exampleZh: "通勤要花很长时间。" },
    { display: "in my spare time", meaningZh: "空闲时间", unitType: "functional_expression", difficulty: "basic", exampleEn: "In my spare time I read.", exampleZh: "空闲时我读书。" },
  ],
  cost: [
    { display: "cost a fortune", meaningZh: "花一大笔钱", unitType: "collocation", difficulty: "intermediate", exampleEn: "It cost a fortune to fix.", exampleZh: "修它花了一大笔钱。" },
    { display: "within budget", meaningZh: "在预算内", unitType: "collocation", difficulty: "intermediate", exampleEn: "I kept everything within budget.", exampleZh: "一切都在预算内。" },
    { display: "It's worth every penny.", meaningZh: "物超所值", unitType: "lexical_chunk", difficulty: "advanced", exampleEn: "The course is worth every penny.", exampleZh: "这个课程物超所值。" },
  ],
  influence: [
    { display: "have a huge influence on...", meaningZh: "对…影响巨大", unitType: "collocation", difficulty: "intermediate", exampleEn: "Teachers have a huge influence on kids.", exampleZh: "老师对孩子影响巨大。" },
    { display: "shape the way...", meaningZh: "塑造…的方式", unitType: "collocation", difficulty: "advanced", exampleEn: "Social media shapes the way we talk.", exampleZh: "社交媒体塑造了我们说话的方式。" },
    { display: "rub off on someone", meaningZh: "感染到某人", unitType: "phrasal_verb", difficulty: "advanced", exampleEn: "Her positivity rubbed off on me.", exampleZh: "她的乐观感染了我。" },
  ],
  difficulty: [
    { display: "struggle with...", meaningZh: "在…上很吃力", unitType: "collocation", difficulty: "intermediate", exampleEn: "I struggle with grammar sometimes.", exampleZh: "我有时在语法上很吃力。" },
    { display: "It's easier said than done.", meaningZh: "说来容易做来难", unitType: "idiom", difficulty: "advanced", exampleEn: "Quitting sugar? Easier said than done.", exampleZh: "戒糖？说来容易做来难。" },
    { display: "get the hang of...", meaningZh: "掌握…的窍门", unitType: "collocation", difficulty: "advanced", exampleEn: "I finally got the hang of it.", exampleZh: "我终于上手了。" },
  ],
  method: [
    { display: "the key is to...", meaningZh: "关键是…", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "The key is to practice daily.", exampleZh: "关键是每天练。" },
    { display: "trial and error", meaningZh: "反复试错", unitType: "collocation", difficulty: "intermediate", exampleEn: "I learned cooking by trial and error.", exampleZh: "我做菜是靠反复试错学的。" },
    { display: "It works for me.", meaningZh: "这方法对我有效", unitType: "lexical_chunk", difficulty: "intermediate", exampleEn: "Studying at night works for me.", exampleZh: "晚上学习对我有效。" },
  ],
  benefit: [
    { display: "do wonders for...", meaningZh: "对…效果极好", unitType: "collocation", difficulty: "advanced", exampleEn: "Walking does wonders for your mood.", exampleZh: "散步对心情极好。" },
    { display: "a great way to...", meaningZh: "…的好方法", unitType: "sentence_frame", difficulty: "basic", exampleEn: "It's a great way to make friends.", exampleZh: "这是交朋友的好方法。" },
    { display: "pay off", meaningZh: "得到回报", unitType: "phrasal_verb", difficulty: "intermediate", exampleEn: "All that practice finally paid off.", exampleZh: "所有练习终于有了回报。" },
  ],
  plan: [
    { display: "my plan is to...", meaningZh: "我的计划是…", unitType: "sentence_frame", difficulty: "basic", exampleEn: "My plan is to graduate first.", exampleZh: "我的计划是先毕业。" },
    { display: "long-term goal", meaningZh: "长期目标", unitType: "collocation", difficulty: "intermediate", exampleEn: "My long-term goal is to run my own studio.", exampleZh: "我的长期目标是开自己的工作室。" },
    { display: "figure out the next step", meaningZh: "想清楚下一步", unitType: "collocation", difficulty: "intermediate", exampleEn: "I'm still figuring out the next step.", exampleZh: "我还在想下一步。" },
  ],
  memory: [
    { display: "back in the day", meaningZh: "当年", unitType: "functional_expression", difficulty: "intermediate", exampleEn: "Back in the day we played outside till dark.", exampleZh: "当年我们在外面玩到天黑。" },
    { display: "vivid memory", meaningZh: "清晰的记忆", unitType: "collocation", difficulty: "advanced", exampleEn: "I have a vivid memory of that summer.", exampleZh: "我对那个夏天记忆犹新。" },
    { display: "bring back memories", meaningZh: "勾起回忆", unitType: "collocation", difficulty: "intermediate", exampleEn: "This song brings back memories.", exampleZh: "这首歌勾起回忆。" },
  ],
  situations: [
    { display: "It depends on the situation.", meaningZh: "视情况而定", unitType: "lexical_chunk", difficulty: "intermediate", exampleEn: "It really depends on the situation.", exampleZh: "这真的要看情况。" },
    { display: "in some cases", meaningZh: "在某些情况下", unitType: "functional_expression", difficulty: "intermediate", exampleEn: "In some cases, it's actually better.", exampleZh: "某些情况下反而更好。" },
    { display: "when it comes to...", meaningZh: "说到、涉及…", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "When it comes to money, people get careful.", exampleZh: "谈到钱大家就谨慎了。" },
    { display: "there are times when...", meaningZh: "有时会…", unitType: "sentence_frame", difficulty: "advanced", exampleEn: "There are times when I just want silence.", exampleZh: "有时候我只想要安静。" },
  ],
  balance: [
    { display: "strike a balance between...and...", meaningZh: "在…与…之间找平衡", unitType: "collocation", difficulty: "advanced", exampleEn: "You need to strike a balance between work and rest.", exampleZh: "要在工作和休息之间找平衡。" },
    { display: "a double-edged sword", meaningZh: "双刃剑", unitType: "idiom", difficulty: "advanced", exampleEn: "Technology is a double-edged sword.", exampleZh: "科技是把双刃剑。" },
    { display: "moderation is key", meaningZh: "适度最重要", unitType: "lexical_chunk", difficulty: "advanced", exampleEn: "Moderation is key with social media.", exampleZh: "用社交媒体关键在适度。" },
  ],
  advice: [
    { display: "I'd suggest...", meaningZh: "我建议…", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "I'd suggest starting small.", exampleZh: "我建议从小处开始。" },
    { display: "It's worth a try.", meaningZh: "值得一试", unitType: "lexical_chunk", difficulty: "intermediate", exampleEn: "If you can, it's worth a try.", exampleZh: "如果可以，值得一试。" },
    { display: "look for ways to...", meaningZh: "想办法…", unitType: "collocation", difficulty: "intermediate", exampleEn: "We should look for ways to cut waste.", exampleZh: "我们应该想办法减少浪费。" },
    { display: "what really helps is...", meaningZh: "真正有用的是…", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "What really helps is planning ahead.", exampleZh: "真正有用的是提前规划。" },
  ],
  instance: [
    { display: "a wide range of...", meaningZh: "各种各样的…", unitType: "collocation", difficulty: "intermediate", exampleEn: "There's a wide range of options online.", exampleZh: "网上选择特别多。" },
    { display: "one that stands out is...", meaningZh: "印象最深的一个是…", unitType: "sentence_frame", difficulty: "advanced", exampleEn: "One that stands out is my old bike.", exampleZh: "印象最深的是我的旧自行车。" },
    { display: "all sorts of...", meaningZh: "各种各样的…", unitType: "collocation", difficulty: "basic", exampleEn: "They sell all sorts of snacks.", exampleZh: "他们卖各种零食。" },
    { display: "I've tried a few, like...", meaningZh: "我试过一些，比如…", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "I've tried a few, like badminton and swimming.", exampleZh: "我试过一些，比如羽毛球和游泳。" },
  ],
  atmosphere: [
    { display: "a lively atmosphere", meaningZh: "热闹的氛围", unitType: "collocation", difficulty: "intermediate", exampleEn: "The market has a lively atmosphere.", exampleZh: "市场里氛围很热闹。" },
    { display: "peaceful and quiet", meaningZh: "宁静祥和", unitType: "collocation", difficulty: "basic", exampleEn: "The area is peaceful and quiet.", exampleZh: "这个区域宁静祥和。" },
    { display: "it has a great vibe", meaningZh: "氛围特别好", unitType: "lexical_chunk", difficulty: "advanced", exampleEn: "That café has a great vibe.", exampleZh: "那家咖啡馆氛围特别好。" },
    { display: "well-maintained", meaningZh: "维护得很好", unitType: "collocation", difficulty: "intermediate", exampleEn: "The facilities are well-maintained.", exampleZh: "设施维护得很好。" },
  ],
  lesson: [
    { display: "It taught me to...", meaningZh: "它教会我…", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "It taught me to be patient.", exampleZh: "它教会我耐心。" },
    { display: "a valuable lesson", meaningZh: "宝贵的教训", unitType: "collocation", difficulty: "intermediate", exampleEn: "I learned a valuable lesson from it.", exampleZh: "我从中得到宝贵教训。" },
    { display: "Looking back, ...", meaningZh: "回头来看…", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "Looking back, it was a turning point.", exampleZh: "回头来看那是个转折点。" },
  ],
  technology: [
    { display: "rely heavily on technology", meaningZh: "高度依赖科技", unitType: "collocation", difficulty: "intermediate", exampleEn: "We rely heavily on technology nowadays.", exampleZh: "如今我们高度依赖科技。" },
    { display: "tech-savvy", meaningZh: "精通科技的", unitType: "collocation", difficulty: "advanced", exampleEn: "Kids today are so tech-savvy.", exampleZh: "今天的孩子特别精通科技。" },
    { display: "screen time", meaningZh: "屏幕使用时间", unitType: "collocation", difficulty: "intermediate", exampleEn: "I'm cutting down my screen time.", exampleZh: "我在减少屏幕时间。" },
    { display: "face-to-face interaction", meaningZh: "面对面交流", unitType: "collocation", difficulty: "intermediate", exampleEn: "Face-to-face interaction is fading.", exampleZh: "面对面交流越来越少。" },
  ],
};

/** dimId → 语义类映射规则（按优先级顺序匹配关键词） */
const DIM_RULES: Array<[DimClass, RegExp]> = [
  ["reason", /reason|why|because|cause|background/],
  ["like", /like|favorite|favourite|enjoy|love|into|fan|hobby-interest|interest/],
  ["dislike", /dislike|annoy|hate|boring|bored/],
  ["attitude", /attitude|opinion|view|yes-no|should|good-or-not|important|importance|willingness|eagerness|feelings-about/],
  ["comparison", /comparison|compare|contrast|vs|differences|generational/],
  ["frequency", /frequency|often|habit|regular|routine/],
  ["change", /change|over-time|trend|development|now-view|usage-change|transition/],
  ["future", /future|plan|wish|expectation|next|goals?|career-goals|timeline|vision/],
  ["past", /past|childhood|memory|memories|history|back-then|used-to|origin|starting/],
  ["feeling", /feeling|feel|mood|emotion|sensation/],
  ["evaluation", /evaluation|pros-cons|benefits|downside|advantages?|disadvantages?|effect|impact|value|significance|result|outcome|effectiveness|quality/],
  ["example", /examples?|instance|specific/],
  ["preference", /preference|prefer|rather|lean|choice/],
  ["people", /people|friends?|neighbors?|companions|who|relationship|team|personality|social|gratitude|recognition|admiration|character|playmates?/],
  ["place", /place|where|location|area|city|room|spots?|route|destination|galleries?|美术馆/],
  ["time", /time|when|duration|occasion|timing|age|hours|schedule|days-off/],
  ["cost", /cost|budget|spending|price|money|salary|expensive/],
  ["influence", /influence|inspiration|shape|effects-on|role-model|impact/],
  ["difficulty", /difficulty|challenge|hard|risk|obstacle|concern|struggle|barrier/],
  ["method", /method|ways?|how|tips|skills?|techniques|process|steps|guidance|learning/],
  ["benefit", /benefit|advantage|plus|good-things|helps?/],
  ["plan", /plan|goal|steps|arrangement|preparations?/],
  ["memory", /memor(y|ies)|nostalgia/],
  ["situations", /situations?|conditions?|occasions?|circumstances|cases|scenarios?/],
  ["balance", /balance|trade-?offs?|moderation/],
  ["advice", /advice|tips|suggestions?|improvements?|measures|coping|solutions?|recommendation|remedies/],
  ["instance", /activities?|experiences?|what|content|topics?|kinds|types|features?|factors?|sources?|channels?|forms?|examples?-based|things|variety|range|etiquette|customs?|items?|elements?/],
  ["evaluation", /drawbacks?|popularity|dependency|reliance|safety|creativity|responsibilit/],
  ["atmosphere", /atmosphere|environment|vibe|facilities|well-kept|surroundings/],
  ["lesson", /lesson|taught|takeaway|insight/],
  ["technology", /technology|tech|digital|app|device|online|internet|ai/],
  ["advice", /alternatives?/],
  ["situations", /exceptions?|individual|personal/],
  ["instance", /sharing|shared|boundaries|stories?|purposes?|description|culture|cultural|subjects?|exhibits?|works?|programs?|uses?|building|buildings?|museum|museums|kinds-of|aspects?|interesting-parts?|food|foods?|meals?|snacks|popular-sports?|sports?|games?|genres?|materials?|books?|music|songs?|dishes|weather|sights?|scenery|reactions?|feedback|plots?|pandas|highlights?|problem|plot/],
  ["benefit", /accessibilit|accessible|health|jobs?|convenien|perks|rewards?|doing-well/],
  ["attitude", /psychology|mindset|essence|perspective|opinion|willingness/],
  ["feeling", /attachment|feelings-toward|pride|gratitude/],
  ["benefit", /conveniences?|opportunities?|perks/],
  ["people", /family|parents?|celebrit(y|ies)|elders?|teachers?|colleagues?|neighbors?|audience|companions?|friends?/],
  ["situations", /life-pace|privacy|pace/],
  ["method", /advice|skills?/],
];

const ZH_RULES: Array<[DimClass, RegExp]> = [
  ["reason", /理由|原因|目的|为什么/],
  ["like", /喜欢|最爱|着迷|喜爱|最爱之物/],
  ["attitude", /态度|看法|观点|是否愿意/],
  ["comparison", /对比|比较|差异|区别|相比|不同/],
  ["frequency", /频率|习惯|经常/],
  ["change", /变化|趋势|改变|发展|前后|成长/],
  ["future", /未来|将来|打算|目标|愿望|期待|梦想|规划|计划|想尝试/],
  ["past", /过去|童年|小时候|历史|当年|传统/],
  ["feeling", /感受|心情|感觉|回忆|情感|归属|骄傲/],
  ["evaluation", /意义|寓意|价值|启示|道理|收获|好处|利弊|影响|作用|效果|重要|意义|成就/],
  ["instance", /庆祝|布置|装修|收获|种菜|水果|蔬菜|早餐|零食|礼物|吃饭|游戏|玩具|表演|展览|景点|赛事|生活|日常|活动|类型|种类|景点|故事|剧情/],
  ["people", /借出|借入|归还|互助|邻里|分享|联系|探望|照顾|帮忙|家人|朋友|邻居|老师|名人|长辈|孩子|儿童|同事|伙伴|相处|交往/],
  ["situations", /情况|场合|场景|规矩|规则|规定|礼仪|习俗|传统|放松|休息/],
  ["atmosphere", /氛围|环境|设施|绿地|装修风格|治安|干净/],
  ["advice", /建议|改进|办法|窍门|提示/],
  ["method", /方法|技巧|经验|渠道|途径|攻略|练习/],
  ["difficulty", /难点|难处|困难|挑战|风险|顾虑|压力/],
  ["time", /作息|时长|频率与习惯|时间/],
  ["place", /位置|地点|场所|区域|周边|风景|风光/],
  ["cost", /花费|预算|价格|钱|成本|薪资/],
];

export function dimToClass(text: string): DimClass | null {
  const id = text.toLowerCase();
  for (const [cls, re] of DIM_RULES) {
    if (re.test(id)) return cls;
  }
  for (const [cls, re] of ZH_RULES) {
    if (re.test(text)) return cls;
  }
  return null;
}
