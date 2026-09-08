/**
 * 话题专属语块池（人工策划）Part 1：Part1/Part3 常见话题。
 * dims = 该 chunk 可覆盖的 blueprint 维度 id。
 * 版本: pools-v1
 */
export interface PoolChunk {
  display: string;
  meaningZh: string;
  unitType: "collocation" | "lexical_chunk" | "phrasal_verb" | "sentence_frame" | "construction" | "functional_expression" | "idiom";
  difficulty: "basic" | "intermediate" | "advanced";
  exampleEn: string;
  exampleZh?: string;
  dims: string[];
}

export const TOPIC_POOLS: Record<string, PoolChunk[]> = {
  广告与媒体: [
    { display: "target audience", meaningZh: "目标受众", unitType: "collocation", difficulty: "intermediate", exampleEn: "Every ad is designed for a target audience.", dims: ["audience", "audience-people"] },
    { display: "eye-catching", meaningZh: "抢眼的", unitType: "collocation", difficulty: "intermediate", exampleEn: "The poster was so eye-catching.", dims: ["success", "factors", "memorability"] },
    { display: "exaggerate the benefits", meaningZh: "夸大功效", unitType: "collocation", difficulty: "advanced", exampleEn: "Some ads exaggerate the benefits.", dims: ["false-promises", "misinformation", "manipulation"] },
    { display: "brush up on", meaningZh: "温习、提高", unitType: "phrasal_verb", difficulty: "intermediate", exampleEn: "Ads teach you phrases to brush up on.", dims: ["educational", "information"] },
    { display: "word of mouth", meaningZh: "口碑", unitType: "collocation", difficulty: "advanced", exampleEn: "Word of mouth beats any advertisement.", dims: ["effectiveness", "effect"] },
    { display: "pop up everywhere", meaningZh: "到处都是", unitType: "lexical_chunk", difficulty: "intermediate", exampleEn: "Ads pop up everywhere online.", dims: ["annoyance", "behavior"] },
    { display: "newspapers are a dying breed", meaningZh: "报纸正在消亡", unitType: "lexical_chunk", difficulty: "advanced", exampleEn: "Sadly, newspapers are a dying breed.", dims: ["still-read", "who-reads", "online-shift"] },
    { display: "get the latest news", meaningZh: "获取最新消息", unitType: "collocation", difficulty: "basic", exampleEn: "I get the latest news on my phone.", dims: ["information", "sources", "purposes"] },
  ],
  规则与社会: [
    { display: "keep things in order", meaningZh: "维持秩序", unitType: "collocation", difficulty: "intermediate", exampleEn: "Rules keep things in order.", dims: ["order", "purpose", "society"] },
    { display: "lay down the law", meaningZh: "立下规矩", unitType: "idiom", difficulty: "advanced", exampleEn: "Schools lay down the law about phones.", dims: ["existing-laws", "rules", "school-rules"] },
    { display: "enforce the rules", meaningZh: "执行规则", unitType: "collocation", difficulty: "advanced", exampleEn: "It's one thing to make laws; another to enforce them.", dims: ["enforcement", "challenges"] },
    { display: "punishment doesn't always work", meaningZh: "惩罚不一定有效", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "Punishment doesn't always work on kids.", dims: ["effectiveness", "purpose", "alternatives"] },
    { display: "keep up with the times", meaningZh: "跟上时代", unitType: "collocation", difficulty: "intermediate", exampleEn: "Laws need to keep up with the times.", dims: ["cyber-law", "changes", "influences"] },
    { display: "raise awareness", meaningZh: "提高意识", unitType: "collocation", difficulty: "intermediate", exampleEn: "Campaigns raise awareness of recycling.", dims: ["advocacy", "education", "incentives"] },
    { display: "go green", meaningZh: "践行环保", unitType: "collocation", difficulty: "intermediate", exampleEn: "More families are going green.", dims: ["signs", "drives", "daily-actions"] },
    { display: "cut down on plastic", meaningZh: "减少塑料使用", unitType: "collocation", difficulty: "intermediate", exampleEn: "We should cut down on plastic bags.", dims: ["daily-actions", "measures", "consumption"] },
  ],
  工作或学习: [
    { display: "major in", meaningZh: "主修", unitType: "collocation", difficulty: "basic", exampleEn: "I major in computer science.", dims: ["major", "subject", "job"] },
    { display: "a third-year student", meaningZh: "大三学生", unitType: "collocation", difficulty: "basic", exampleEn: "I'm a third-year student.", dims: ["year", "duration"] },
    { display: "do an internship", meaningZh: "参加实习", unitType: "lexical_chunk", difficulty: "intermediate", exampleEn: "I'm hoping to do an internship this summer.", dims: ["plans", "career", "preparations"] },
    { display: "nine-to-five job", meaningZh: "朝九晚五的工作", unitType: "collocation", difficulty: "intermediate", exampleEn: "A nine-to-five job isn't for everyone.", dims: ["job", "likes", "workload"] },
    { display: "meet the requirements", meaningZh: "满足要求", unitType: "collocation", difficulty: "intermediate", exampleEn: "I had to meet the requirements first.", dims: ["requirements", "skills", "education"] },
    { display: "on the job", meaningZh: "在工作中", unitType: "functional_expression", difficulty: "intermediate", exampleEn: "You learn a lot on the job.", dims: ["efficiency", "technology", "duties"] },
    { display: "heavy workload", meaningZh: "繁重的工作量", unitType: "collocation", difficulty: "intermediate", exampleEn: "The heavy workload stresses me out.", dims: ["workload", "concerns", "pressures"] },
    { display: "career prospects", meaningZh: "职业前景", unitType: "collocation", difficulty: "advanced", exampleEn: "The career prospects look promising.", dims: ["job-prospects", "development", "future"] },
    { display: "switch majors", meaningZh: "转专业", unitType: "collocation", difficulty: "intermediate", exampleEn: "Some students switch majors in year two.", dims: ["wish", "new-major", "change"] },
    { display: "five-year plan", meaningZh: "五年计划", unitType: "collocation", difficulty: "intermediate", exampleEn: "My five-year plan is pretty simple.", dims: ["plans", "short-term", "long-term"] },
  ],
  "家/住所": [
    { display: "a cosy apartment", meaningZh: "温馨的公寓", unitType: "collocation", difficulty: "intermediate", exampleEn: "I live in a cosy apartment downtown.", dims: ["type", "room", "description"] },
    { display: "spacious", meaningZh: "宽敞的", unitType: "collocation", difficulty: "intermediate", exampleEn: "The living room is really spacious.", dims: ["features", "inside", "appearance"] },
    { display: "rent an apartment", meaningZh: "租公寓", unitType: "collocation", difficulty: "intermediate", exampleEn: "I rent an apartment near campus.", dims: ["rent", "reasons", "housing"] },
    { display: "live on my own", meaningZh: "自己住", unitType: "collocation", difficulty: "intermediate", exampleEn: "I live on my own now.", dims: ["independence", "who", "alone"] },
    { display: "do the housework", meaningZh: "做家务", unitType: "collocation", difficulty: "basic", exampleEn: "We share the housework.", dims: ["activities", "habits", "evenings"] },
    { display: "curl up on the sofa", meaningZh: "窝在沙发上", unitType: "collocation", difficulty: "advanced", exampleEn: "I curl up on the sofa and read.", dims: ["alone", "relax", "pleasant-things"] },
    { display: "make yourself at home", meaningZh: "像在自己家一样放松", unitType: "idiom", difficulty: "intermediate", exampleEn: "Guests always make themselves at home.", dims: ["guests", "atmosphere", "comfort-elements"] },
    { display: "home is where the heart is", meaningZh: "心之所在即为家", unitType: "idiom", difficulty: "advanced", exampleEn: "Home is where the heart is, after all.", dims: ["feelings", "attachment", "comfort"] },
  ],
  家乡: [
    { display: "be located in", meaningZh: "位于", unitType: "collocation", difficulty: "basic", exampleEn: "My hometown is located in the southwest.", dims: ["location", "distance", "overview"] },
    { display: "a mid-sized city", meaningZh: "中型城市", unitType: "collocation", difficulty: "intermediate", exampleEn: "It's a mid-sized city with a rich history.", dims: ["size", "description", "overview"] },
    { display: "local delicacies", meaningZh: "本地美食", unitType: "collocation", difficulty: "advanced", exampleEn: "Our local delicacies are famous nationwide.", dims: ["food", "famous-for", "specialties"] },
    { display: "tourist attractions", meaningZh: "旅游景点", unitType: "collocation", difficulty: "intermediate", exampleEn: "We have several tourist attractions.", dims: ["sights", "famous-for", "recommend"] },
    { display: "a slower pace of life", meaningZh: "更慢的生活节奏", unitType: "collocation", difficulty: "intermediate", exampleEn: "The town offers a slower pace of life.", dims: ["life-pace", "atmosphere", "likes"] },
    { display: "brain drain", meaningZh: "人才流失", unitType: "collocation", difficulty: "advanced", exampleEn: "Brain drain is a real issue back home.", dims: ["outflow", "young-people", "effects"] },
    { display: "be attached to", meaningZh: "对…有感情", unitType: "collocation", difficulty: "advanced", exampleEn: "I'm deeply attached to my hometown.", dims: ["attachment", "feelings", "like-or-not"] },
    { display: "learn about its history", meaningZh: "了解它的历史", unitType: "collocation", difficulty: "basic", exampleEn: "We learned about its history at school.", dims: ["learned", "history-culture", "school-learning"] },
  ],
  教育与成长: [
    { display: "pick up a language", meaningZh: "学会一门语言", unitType: "collocation", difficulty: "intermediate", exampleEn: "Kids pick up languages so fast.", dims: ["levels", "languages", "brain"] },
    { display: "immerse yourself in", meaningZh: "沉浸于", unitType: "collocation", difficulty: "advanced", exampleEn: "Immerse yourself in the language and it sticks.", dims: ["methods", "practice", "resources"] },
    { display: "rote learning", meaningZh: "死记硬背", unitType: "collocation", difficulty: "advanced", exampleEn: "Rote learning kills creativity.", dims: ["methods", "beyond-academic", "fear"] },
    { display: "hands-on experience", meaningZh: "动手经验", unitType: "collocation", difficulty: "intermediate", exampleEn: "Hands-on experience beats textbooks.", dims: ["practice", "hands-on", "experiments"] },
    { display: "fall behind", meaningZh: "落后", unitType: "phrasal_verb", difficulty: "intermediate", exampleEn: "Kids fall behind without extra help.", dims: ["too-many", "signs", "pressure"] },
    { display: "well-rounded", meaningZh: "全面发展的", unitType: "collocation", difficulty: "advanced", exampleEn: "Schools should produce well-rounded students.", dims: ["beyond-academic", "focus", "balance"] },
    { display: "burn out", meaningZh: "累垮", unitType: "phrasal_verb", difficulty: "advanced", exampleEn: "Students burn out under pressure.", dims: ["pressure", "negative", "manifestations"] },
  ],
  名气媒体: [
    { display: "overnight sensation", meaningZh: "一夜爆红", unitType: "collocation", difficulty: "advanced", exampleEn: "One viral video made him an overnight sensation.", dims: ["viral", "viral-fame", "accessibility"] },
    { display: "in the public eye", meaningZh: "受公众关注", unitType: "collocation", difficulty: "advanced", exampleEn: "Fame keeps you in the public eye.", dims: ["pressure", "behavior", "responsibilities"] },
    { display: "15 minutes of fame", meaningZh: "短暂的出名", unitType: "idiom", difficulty: "advanced", exampleEn: "Social media gives everyone 15 minutes of fame.", dims: ["essence", "quality", "type"] },
    { display: "a role model for young people", meaningZh: "年轻人的榜样", unitType: "collocation", difficulty: "intermediate", exampleEn: "Famous people are role models for young people.", dims: ["role-model", "influence", "responsibilities"] },
    { display: "the price of fame", meaningZh: "名声的代价", unitType: "collocation", difficulty: "advanced", exampleEn: "The price of fame is your privacy.", dims: ["downsides", "pressure", "tradeoffs"] },
  ],
  娱乐电影音乐: [
    { display: "a box-office hit", meaningZh: "票房大片", unitType: "collocation", difficulty: "advanced", exampleEn: "The film was a box-office hit.", dims: ["success", "marketing", "factors"] },
    { display: "special effects", meaningZh: "特效", unitType: "collocation", difficulty: "intermediate", exampleEn: "The special effects were stunning.", dims: ["factors", "sound", "acting-directing"] },
    { display: "a blockbuster", meaningZh: "大片", unitType: "collocation", difficulty: "intermediate", exampleEn: "Summer is full of blockbusters.", dims: ["popular-genres", "tastes", "domestic"] },
    { display: "sing along to", meaningZh: "跟着唱", unitType: "phrasal_verb", difficulty: "intermediate", exampleEn: "Everyone sings along to the chorus.", dims: ["connection", "live", "atmosphere"] },
    { display: "get carried away", meaningZh: "忘乎所以", unitType: "idiom", difficulty: "advanced", exampleEn: "Fans get carried away at concerts.", dims: ["atmosphere", "experience", "connection"] },
    { display: "an acquired taste", meaningZh: "需要慢慢培养的喜好", unitType: "idiom", difficulty: "advanced", exampleEn: "Jazz is an acquired taste.", dims: ["different-tastes", "overlap", "genres"] },
    { display: "my taste in music has changed", meaningZh: "我的音乐品味变了", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "My taste in music has changed over the years.", dims: ["old", "young", "reasons"] },
  ],
  社会行为: [
    { display: "mind your manners", meaningZh: "注意礼貌", unitType: "collocation", difficulty: "intermediate", exampleEn: "Kids should mind their manners at the table.", dims: ["good-manners", "meals", "etiquette"] },
    { display: "common courtesy", meaningZh: "基本的礼貌", unitType: "collocation", difficulty: "advanced", exampleEn: "Common courtesy is fading, sadly.", dims: ["politeness", "connected-or-not", "cultivation"] },
    { display: "first impressions matter", meaningZh: "第一印象很重要", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "First impressions matter a lot.", dims: ["first-impression", "attitude", "friendliness"] },
    { display: "a random act of kindness", meaningZh: "不经意的善举", unitType: "collocation", difficulty: "advanced", exampleEn: "A random act of kindness makes someone's day.", dims: ["small-acts", "kindness", "examples"] },
    { display: "swallow your pride", meaningZh: "放下自尊", unitType: "idiom", difficulty: "advanced", exampleEn: "You have to swallow your pride and ask for help.", dims: ["rejection-fear", "pride", "independence"] },
    { display: "reach out to", meaningZh: "主动联系求助", unitType: "phrasal_verb", difficulty: "intermediate", exampleEn: "Reach out to family when things get hard.", dims: ["problem-type", "family", "other-sources"] },
  ],
  工作与成功: [
    { display: "climb the career ladder", meaningZh: "往上爬、晋升", unitType: "collocation", difficulty: "advanced", exampleEn: "Some people just want to climb the career ladder.", dims: ["positions", "reasons", "money-status"] },
    { display: "job security", meaningZh: "工作稳定性", unitType: "collocation", difficulty: "intermediate", exampleEn: "Job security matters more than salary for some.", dims: ["considerations", "factors", "risks"] },
    { display: "work-life balance", meaningZh: "工作生活平衡", unitType: "collocation", difficulty: "intermediate", exampleEn: "Work-life balance is my top priority.", dims: ["work-life", "benefits", "balance"] },
    { display: " persevere through hardship", meaningZh: "坚持渡过难关", unitType: "collocation", difficulty: "advanced", exampleEn: "Success belongs to those who persevere through hardship.", dims: ["persistence", "efforts", "difficulties"] },
    { display: "a stroke of luck", meaningZh: "一点运气", unitType: "collocation", difficulty: "advanced", exampleEn: "Talent plus a stroke of luck does it.", dims: ["luck", "talent-vs-luck", "modern-factor"] },
    { display: "follow your passion", meaningZh: "追随热情", unitType: "collocation", difficulty: "intermediate", exampleEn: "Follow your passion, but stay realistic.", dims: ["passion", "meaning", "dream-job"] },
  ],
  科技手机: [
    { display: "glued to the screen", meaningZh: "盯着屏幕不放", unitType: "idiom", difficulty: "advanced", exampleEn: "Kids are glued to the screen all day.", dims: ["too-dependent", "manifestations", "negative"] },
    { display: "keep in touch with", meaningZh: "保持联系", unitType: "collocation", difficulty: "basic", exampleEn: "Apps help us keep in touch with friends.", dims: ["communication", "speed", "social-media"] },
    { display: "face-to-face", meaningZh: "面对面", unitType: "collocation", difficulty: "basic", exampleEn: "Nothing beats face-to-face chats.", dims: ["non-verbal", "disadvantages", "situations"] },
    { display: "set screen-time limits", meaningZh: "设置屏幕时间限制", unitType: "collocation", difficulty: "intermediate", exampleEn: "Parents set screen-time limits at home.", dims: ["regulate", "balance", "guidance"] },
    { display: "the older generation", meaningZh: "老一辈", unitType: "collocation", difficulty: "basic", exampleEn: "The older generation prefers phone calls.", dims: ["usage-diff", "old-people", "generational-gap"] },
  ],
  艺术创造力: [
    { display: "think outside the box", meaningZh: "跳出框框思考", unitType: "idiom", difficulty: "advanced", exampleEn: "Designers think outside the box.", dims: ["innovation", "jobs", "creativity"] },
    { display: "let your imagination run wild", meaningZh: "放飞想象", unitType: "idiom", difficulty: "advanced", exampleEn: "Let your imagination run wild on the canvas.", dims: ["imagination", "children", "ways"] },
    { display: "spark creativity", meaningZh: "激发创造力", unitType: "collocation", difficulty: "advanced", exampleEn: "Art classes spark creativity early.", dims: ["education", "benefits", "curriculum"] },
    { display: "out-of-the-box ideas", meaningZh: "有创意的想法", unitType: "collocation", difficulty: "advanced", exampleEn: "Inventions start with out-of-the-box ideas.", dims: ["inventions", "science", "logic"] },
  ],
  消费金钱: [
    { display: "impulse buying", meaningZh: "冲动消费", unitType: "collocation", difficulty: "advanced", exampleEn: "Sales trigger impulse buying.", dims: ["emotions", "impulse", "desires"] },
    { display: "keep track of spending", meaningZh: "记录开销", unitType: "collocation", difficulty: "intermediate", exampleEn: "I keep track of spending with an app.", dims: ["methods", "saving", "rationality"] },
    { display: "a rainy-day fund", meaningZh: "应急储蓄", unitType: "collocation", difficulty: "advanced", exampleEn: "Everyone needs a rainy-day fund.", dims: ["emergency", "benefits", "importance"] },
    { display: "splash out on", meaningZh: "大手笔花钱", unitType: "phrasal_verb", difficulty: "advanced", exampleEn: "People splash out on designer bags.", dims: ["high-price-items", "status", "reasons"] },
    { display: "window shopping", meaningZh: "逛街只看不买", unitType: "collocation", difficulty: "intermediate", exampleEn: "Window shopping is my weekend therapy.", dims: ["entertainment", "shopping-mall", "attitude"] },
  ],
  家庭教育: [
    { display: "strict but fair", meaningZh: "严格但公平", unitType: "collocation", difficulty: "intermediate", exampleEn: "My parents were strict but fair.", dims: ["strict-or-not", "degree", "drawbacks"] },
    { display: "positive reinforcement", meaningZh: "正向激励", unitType: "collocation", difficulty: "advanced", exampleEn: "Positive reinforcement works better than punishment.", dims: ["rewards", "ways", "principles"] },
    { display: "lend a hand with the chores", meaningZh: "帮忙做家务", unitType: "collocation", difficulty: "intermediate", exampleEn: "Kids can lend a hand with the chores.", dims: ["chores", "should", "age-tasks"] },
    { display: "praise someone for", meaningZh: "因…表扬某人", unitType: "construction", difficulty: "intermediate", exampleEn: "Praise children for effort, not results.", dims: ["words", "ways", "encouragement"] },
    { display: "set a good example", meaningZh: "树立好榜样", unitType: "collocation", difficulty: "intermediate", exampleEn: "Parents set a good example by reading.", dims: ["role-model", "parental-role", "influence"] },
  ],
  你居住的区域: [
    { display: "a strong sense of community", meaningZh: "浓厚的社区感", unitType: "collocation", difficulty: "advanced", exampleEn: "Our area has a strong sense of community.", dims: ["community", "closeness", "friendly-or-not"] },
    { display: "within walking distance", meaningZh: "步行可达", unitType: "collocation", difficulty: "intermediate", exampleEn: "Everything is within walking distance.", dims: ["facilities", "places", "conveniences"] },
    { display: "under construction", meaningZh: "施工中", unitType: "collocation", difficulty: "intermediate", exampleEn: "A new metro line is under construction.", dims: ["construction", "changes", "improvements"] },
    { display: "local shops", meaningZh: "本地商铺", unitType: "collocation", difficulty: "basic", exampleEn: "Local shops are reopening after the renovation.", dims: ["shops", "changes", "areas"] },
  ],
  人生阶段: [
    { display: "a milestone", meaningZh: "人生里程碑", unitType: "collocation", difficulty: "intermediate", exampleEn: "Graduation is a big milestone.", dims: ["milestones", "memory-ways", "stages"] },
    { display: "the good old days", meaningZh: "过去的好时光", unitType: "idiom", difficulty: "intermediate", exampleEn: "We always talk about the good old days.", dims: ["forgetting", "photos", "past"] },
    { display: "take up a new hobby", meaningZh: "开始新爱好", unitType: "collocation", difficulty: "intermediate", exampleEn: "Retirement is a time to take up a new hobby.", dims: ["life", "study", "career"] },
  ],
  科学: [
    { display: "do experiments", meaningZh: "做实验", unitType: "collocation", difficulty: "basic", exampleEn: "We did experiments in science class.", dims: ["experiments", "hands-on", "experiences"] },
    { display: "science museum", meaningZh: "科学博物馆", unitType: "collocation", difficulty: "basic", exampleEn: "The science museum is free on Mondays.", dims: ["tv-museums", "programs", "cities"] },
    { display: "be fascinated by", meaningZh: "被…吸引", unitType: "collocation", difficulty: "advanced", exampleEn: "I was fascinated by astronomy as a kid.", dims: ["interest", "topics", "curiosity"] },
    { display: "science documentaries", meaningZh: "科学纪录片", unitType: "collocation", difficulty: "intermediate", exampleEn: "Science documentaries are my thing.", dims: ["programs", "sources", "what-learned"] },
  ],
  宠物和动物: [
    { display: "keep pets", meaningZh: "养宠物", unitType: "collocation", difficulty: "basic", exampleEn: "More families keep pets these days.", dims: ["keeping", "pets", "popularity"] },
    { display: "loyal companion", meaningZh: "忠实的伙伴", unitType: "collocation", difficulty: "intermediate", exampleEn: "A dog is a loyal companion.", dims: ["companionship", "favorite-animal", "reasons"] },
    { display: "take care of", meaningZh: "照顾", unitType: "phrasal_verb", difficulty: "basic", exampleEn: "Kids learn responsibility by taking care of pets.", dims: ["responsibility", "lessons", "care"] },
    { display: "animal welfare", meaningZh: "动物福利", unitType: "collocation", difficulty: "advanced", exampleEn: "Animal welfare is taken more seriously now.", dims: ["welfare", "protection", "changes"] },
    { display: "national treasure", meaningZh: "国宝", unitType: "collocation", difficulty: "intermediate", exampleEn: "Pandas are a national treasure in China.", dims: ["popular-animal", "symbolism", "pandas"] },
  ],
};
