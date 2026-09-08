/**
 * 话题专属语块池 Part 3：覆盖最后一批维度（pools-v3）。
 */
import type { PoolChunk } from "./topic_pools";

export const TOPIC_POOLS_3: Record<string, PoolChunk[]> = {
  广告与媒体: [
    { display: "buy things you don't need", meaningZh: "买不需要的东西", unitType: "collocation", difficulty: "intermediate", exampleEn: "Ads tempt you to buy things you don't need.", dims: ["gifts", "desires"] },
    { display: "it fits my lifestyle", meaningZh: "符合我的生活方式", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "I only keep what fits my lifestyle.", dims: ["lifestyle", "consumption"] },
    { display: "mass tourism", meaningZh: "大众旅游", unitType: "collocation", difficulty: "advanced", exampleEn: "Mass tourism hurts small towns.", dims: ["mass-tourism", "problems"] },
    { display: "there's a moral to the story", meaningZh: "故事有寓意", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "There's a moral to every fairy tale.", dims: ["morals", "lesson"] },
    { display: "loyal and friendly", meaningZh: "忠诚友好", unitType: "collocation", difficulty: "basic", exampleEn: "Dogs are loyal and friendly.", dims: ["qualities", "character"] },
    { display: "tighter regulations", meaningZh: "更严格的规定", unitType: "collocation", difficulty: "advanced", exampleEn: "We need tighter regulations on ads.", dims: ["regulations", "policies"] },
    { display: "a way to unwind", meaningZh: "放松的方式", unitType: "collocation", difficulty: "intermediate", exampleEn: "Gardening is a way to unwind.", dims: ["relaxation", "benefits"] },
  ],
  串题三: [
    { display: "run a small online store", meaningZh: "经营一家网店", unitType: "collocation", difficulty: "intermediate", exampleEn: "She runs a small online store.", dims: ["business", "product"] },
    { display: "go through hard times", meaningZh: "经历艰难时期", unitType: "collocation", difficulty: "intermediate", exampleEn: "Every business goes through hard times.", dims: ["difficulties", "problems"] },
    { display: "refuse to give up", meaningZh: "拒绝放弃", unitType: "lexical_chunk", difficulty: "intermediate", exampleEn: "He refused to give up no matter what.", dims: ["efforts", "persistence"] },
    { display: "a household name", meaningZh: "家喻户晓的名字", unitType: "idiom", difficulty: "advanced", exampleEn: "Now the brand is a household name.", dims: ["identity", "success"] },
    { display: "attend one of her concerts", meaningZh: "参加她的演唱会", unitType: "lexical_chunk", difficulty: "intermediate", exampleEn: "I'd love to attend one of her concerts.", dims: ["meeting", "concert"] },
    { display: "ask for advice face-to-face", meaningZh: "当面请教", unitType: "collocation", difficulty: "intermediate", exampleEn: "I'd ask for advice face-to-face.", dims: ["questions", "meeting"] },
  ],
  人物杂项: [
    { display: "win a national award", meaningZh: "获得国家级奖项", unitType: "collocation", difficulty: "intermediate", exampleEn: "He won a national award for his research.", dims: ["achievements", "identity"] },
    { display: "a talented musician", meaningZh: "有才华的音乐人", unitType: "collocation", difficulty: "intermediate", exampleEn: "She's a talented musician who plays by ear.", dims: ["qualities", "talent"] },
    { display: "start small", meaningZh: "从小事做起", unitType: "lexical_chunk", difficulty: "intermediate", exampleEn: "I started small — just recycling at home.", dims: ["env-actions", "daily-actions"] },
    { display: "we clicked right away", meaningZh: "一见如故", unitType: "lexical_chunk", difficulty: "advanced", exampleEn: "We clicked right away at the party.", dims: ["first-impression", "now"] },
  ],
  计划决策: [
    { display: "conflicting advice", meaningZh: "相互冲突的建议", unitType: "collocation", difficulty: "advanced", exampleEn: "Too many people give you conflicting advice.", dims: ["conflicts", "problems"] },
    { display: "feel overwhelmed by choices", meaningZh: "被选择淹没", unitType: "collocation", difficulty: "advanced", exampleEn: "You feel overwhelmed by too many opinions.", dims: ["confusion", "conflicts"] },
    { display: "plan as far as", meaningZh: "规划到…程度", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "I plan as far as next year, honestly.", dims: ["extent", "flexibility"] },
    { display: "leave some room for changes", meaningZh: "留出调整空间", unitType: "collocation", difficulty: "advanced", exampleEn: "Leave some room for changes.", dims: ["flexibility", "adjustment"] },
    { display: "make up your own mind", meaningZh: "自己拿主意", unitType: "idiom", difficulty: "advanced", exampleEn: "In the end, you make up your own mind.", dims: ["independence", "learned-or-natural"] },
    { display: "decision-making is a skill", meaningZh: "决策是一种能力", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "Decision-making is a skill you learn by doing.", dims: ["learned-or-natural", "skills"] },
  ],
  家与住所: [
    { display: "a short commute", meaningZh: "通勤时间短", unitType: "collocation", difficulty: "intermediate", exampleEn: "A short commute saves so much time.", dims: ["commute", "convenience"] },
    { display: "keep it simple and tidy", meaningZh: "简单整洁", unitType: "lexical_chunk", difficulty: "intermediate", exampleEn: "I keep the decor simple and tidy.", dims: ["decor", "furniture", "styles"] },
    { display: "within my budget", meaningZh: "在预算之内", unitType: "collocation", difficulty: "intermediate", exampleEn: "A bigger place isn't within my budget yet.", dims: ["realism", "cost"] },
    { display: "it feels warm and bright", meaningZh: "又温暖又明亮", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "The room feels warm and bright.", dims: ["senses", "atmosphere"] },
    { display: "sleep in on weekends", meaningZh: "周末睡懒觉", unitType: "collocation", difficulty: "intermediate", exampleEn: "I sleep in on weekends.", dims: ["weekends", "habits"] },
  ],
  教育成长: [
    { display: "reply at your convenience", meaningZh: "方便时再回复", unitType: "collocation", difficulty: "advanced", exampleEn: "Messaging lets you reply at your convenience.", dims: ["asynchrony", "convenience"] },
    { display: "juggle work and study", meaningZh: "兼顾工作与学习", unitType: "collocation", difficulty: "advanced", exampleEn: "I juggle work and study every day.", dims: ["busy", "balance"] },
    { display: "get things done faster", meaningZh: "更快完成事情", unitType: "collocation", difficulty: "intermediate", exampleEn: "AI helps me get things done faster.", dims: ["efficiency", "fields"] },
    { display: "in fields like healthcare and finance", meaningZh: "在医疗、金融等领域", unitType: "sentence_frame", difficulty: "advanced", exampleEn: "AI is big in fields like healthcare and finance.", dims: ["fields", "jobs"] },
  ],
  汽车: [
    { display: "a sleek electric car", meaningZh: "流线型电动车", unitType: "collocation", difficulty: "advanced", exampleEn: "My dream car is a sleek electric car.", dims: ["dream-car", "types"] },
    { display: "these days I mostly take the metro", meaningZh: "如今我多坐地铁", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "These days I mostly take the metro.", dims: ["now", "changes"] },
    { display: "practical for a family", meaningZh: "适合家庭使用", unitType: "collocation", difficulty: "intermediate", exampleEn: "An SUV is practical for a family.", dims: ["practicality", "features"] },
    { display: "hold its resale value", meaningZh: "保值", unitType: "collocation", difficulty: "advanced", exampleEn: "Some brands hold their resale value well.", dims: ["resale", "cost"] },
  ],
  种菜: [
    { display: "easier than you'd think", meaningZh: "比想象的容易", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "Growing tomatoes is easier than you'd think.", dims: ["easy-or-not", "difficulty"] },
    { display: "it got me hooked", meaningZh: "让我上了瘾", unitType: "lexical_chunk", difficulty: "advanced", exampleEn: "One small pot got me hooked on gardening.", dims: ["interest", "origin"] },
    { display: "sunlight and watering", meaningZh: "阳光和浇水", unitType: "collocation", difficulty: "basic", exampleEn: "Plants mostly need sunlight and watering.", dims: ["knowledge", "care"] },
  ],
  工作: [
    { display: "work in a field you enjoy", meaningZh: "做喜欢的领域", unitType: "collocation", difficulty: "intermediate", exampleEn: "Try to work in a field you enjoy.", dims: ["interest", "passion"] },
    { display: "a solid resume", meaningZh: "漂亮的简历", unitType: "collocation", difficulty: "intermediate", exampleEn: "Certifications make your resume solid.", dims: ["qualifications", "requirements"] },
    { display: "dreams vs reality", meaningZh: "梦想与现实", unitType: "collocation", difficulty: "intermediate", exampleEn: "Every job has a gap between dreams and reality.", dims: ["reality", "meaning"] },
  ],
  海外旅行: [
    { display: "backpack around Australia", meaningZh: "背包游澳大利亚", unitType: "collocation", difficulty: "intermediate", exampleEn: "I'd love to backpack around Australia.", dims: ["country", "trip"] },
    { display: "polish up my English", meaningZh: "提升英语", unitType: "collocation", difficulty: "advanced", exampleEn: "I'd polish up my English while working.", dims: ["requirements", "preparations"] },
  ],
  家族企业: [
    { display: "a family-run bakery", meaningZh: "家族经营的面包店", unitType: "collocation", difficulty: "intermediate", exampleEn: "He works at a family-run bakery.", dims: ["business", "duties"] },
  ],
  整洁: [
    { display: "a place for everything", meaningZh: "物有定位", unitType: "lexical_chunk", difficulty: "advanced", exampleEn: "A place for everything — that's my rule.", dims: ["standard", "habits"] },
    { display: "neat freak", meaningZh: "洁癖、极爱整洁的人", unitType: "idiom", difficulty: "advanced", exampleEn: "My roommate is a neat freak.", dims: ["tidy-or-not", "habits"] },
  ],
  手表: [
    { display: "more of a fashion statement", meaningZh: "更像时尚宣言", unitType: "sentence_frame", difficulty: "advanced", exampleEn: "Watches are more of a fashion statement now.", dims: ["status-symbol", "necessity"] },
    { display: "wear one out of habit", meaningZh: "习惯性戴着", unitType: "collocation", difficulty: "intermediate", exampleEn: "I wear one out of habit.", dims: ["wear-or-not", "habits"] },
  ],
  外太空: [
    { display: "stargazing on clear nights", meaningZh: "晴夜观星", unitType: "collocation", difficulty: "intermediate", exampleEn: "I love stargazing on clear nights.", dims: ["curiosity", "interest"] },
  ],
  科技问题: [
    { display: "it popped up in my feed", meaningZh: "在推送里刷到的", unitType: "lexical_chunk", difficulty: "advanced", exampleEn: "I found the app — it popped up in my feed.", dims: ["discovery", "sources"] },
    { display: "walk me through it", meaningZh: "一步步教我", unitType: "collocation", difficulty: "advanced", exampleEn: "He walked me through the whole fix.", dims: ["solving", "how-helped"] },
  ],
  改变决定: [
    { display: "she took my advice", meaningZh: "她采纳了我的建议", unitType: "collocation", difficulty: "intermediate", exampleEn: "She took my advice and never regretted it.", dims: ["acceptance", "outcome"] },
    { display: "out of nowhere", meaningZh: "毫无预兆地", unitType: "idiom", difficulty: "advanced", exampleEn: "The change came out of nowhere.", dims: ["trigger", "reasons"] },
  ],
  团队沟通: [
    { display: "left on read", meaningZh: "已读不回", unitType: "idiom", difficulty: "advanced", exampleEn: "My message was left on read for days.", dims: ["no-reply", "message-nature"] },
    { display: "coordinate the whole project", meaningZh: "统筹整个项目", unitType: "collocation", difficulty: "advanced", exampleEn: "I coordinated the whole project.", dims: ["your-role", "process"] },
  ],
  完美工作: [
    { display: "day-to-day tasks", meaningZh: "日常工作", unitType: "collocation", difficulty: "intermediate", exampleEn: "My day-to-day tasks involve editing videos.", dims: ["duties", "requirements"] },
  ],
  散步: [
    { display: "walk everywhere", meaningZh: "走到哪算哪、爱步行", unitType: "collocation", difficulty: "basic", exampleEn: "I walk everywhere within two kilometers.", dims: ["walk-a-lot", "habits"] },
    { display: "stroll in the park", meaningZh: "在公园散步", unitType: "collocation", difficulty: "intermediate", exampleEn: "I stroll in the park after dinner.", dims: ["parks", "places"] },
  ],
  旅行风景: [
    { display: "travel somewhere new", meaningZh: "去新的地方旅行", unitType: "collocation", difficulty: "intermediate", exampleEn: "I love travelling somewhere new every year.", dims: ["travel", "scenery"] },
    { display: "capture the moment", meaningZh: "记录瞬间", unitType: "collocation", difficulty: "advanced", exampleEn: "Photos capture the moment perfectly.", dims: ["photos", "equipment"] },
  ],
  食物: [
    { display: "cook at home", meaningZh: "在家做饭", unitType: "collocation", difficulty: "basic", exampleEn: "I cook at home most weekends.", dims: ["cooking", "habits"] },
    { display: "eat out", meaningZh: "下馆子", unitType: "collocation", difficulty: "basic", exampleEn: "We eat out on Fridays.", dims: ["eating-out", "where-eat"] },
  ],
  晨间: [
    { display: "an early riser", meaningZh: "早起的人", unitType: "collocation", difficulty: "intermediate", exampleEn: "I'm an early riser by nature.", dims: ["early-rising", "early-bird"] },
  ],
  爱好: [
    { display: "a hobby I've kept for years", meaningZh: "坚持多年的爱好", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "Swimming is a hobby I've kept for years.", dims: ["lasting-hobby", "continuity"] },
  ],
  礼物: [
    { display: "receive a lovely gift", meaningZh: "收到一份贴心的礼物", unitType: "collocation", difficulty: "intermediate", exampleEn: "I received a lovely gift on my birthday.", dims: ["receiving", "recent-gift"] },
    { display: "give someone a thoughtful present", meaningZh: "送用心的礼物", unitType: "collocation", difficulty: "intermediate", exampleEn: "I gave my mum a thoughtful present.", dims: ["giving", "choosing"] },
  ],
  景观: [
    { display: "a decent camera", meaningZh: "不错的相机", unitType: "collocation", difficulty: "intermediate", exampleEn: "A decent camera helps, but the eye matters more.", dims: ["equipment", "skills"] },
  ],
  公共场所: [
    { display: "it could use more green space", meaningZh: "希望能多点绿地", unitType: "sentence_frame", difficulty: "advanced", exampleEn: "It could use more green space.", dims: ["current", "improvements"] },
  ],
  外出购物: [
    { display: "buy snacks on the spot", meaningZh: "现场买零食", unitType: "collocation", difficulty: "intermediate", exampleEn: "I usually buy snacks on the spot.", dims: ["buying", "habits"] },
  ],
  广告: [
    { display: "an ad that stuck with me", meaningZh: "让我印象深刻的广告", unitType: "lexical_chunk", difficulty: "advanced", exampleEn: "There's an ad that stuck with me for years.", dims: ["memorable-ad", "impressive"] },
  ],
  休息: [
    { display: "a twenty-minute power nap", meaningZh: "二十分钟的小睡", unitType: "collocation", difficulty: "advanced", exampleEn: "A twenty-minute power nap is perfect for me.", dims: ["length", "duration"] },
  ],
  商场建筑: [
    { display: "a huge shopping complex", meaningZh: "大型购物中心", unitType: "collocation", difficulty: "intermediate", exampleEn: "A huge shopping complex opened near us.", dims: ["which-mall", "facilities"] },
  ],
  故事: [
    { display: "a bedtime story", meaningZh: "睡前故事", unitType: "collocation", difficulty: "basic", exampleEn: "My mum read me bedtime stories.", dims: ["story", "memories"] },
  ],
  画画的小孩: [
    { display: "a gifted young artist", meaningZh: "有天赋的小画家", unitType: "collocation", difficulty: "advanced", exampleEn: "He's a gifted young artist.", dims: ["talent", "works"] },
  ],
  成名: [
    { display: "easier said than achieved", meaningZh: "说易做难", unitType: "sentence_frame", difficulty: "advanced", exampleEn: "Fame is easier said than achieved.", dims: ["easier-or-not", "reasons"] },
  ],
  家庭压力: [
    { display: "pressure from school", meaningZh: "学业压力", unitType: "collocation", difficulty: "intermediate", exampleEn: "Kids face huge pressure from school.", dims: ["pressure", "pressures"] },
  ],
  法律: [
    { display: "know the limits of", meaningZh: "了解…的局限", unitType: "collocation", difficulty: "advanced", exampleEn: "You should know the limits of any law.", dims: ["limits", "gaps"] },
  ],
  网站: [
    { display: "adapt to the new layout", meaningZh: "适应新界面", unitType: "collocation", difficulty: "intermediate", exampleEn: "I adapted to the new layout quickly.", dims: ["your-adaptation", "changes"] },
  ],
  购物: [
    { display: "stock up on", meaningZh: "囤货", unitType: "phrasal_verb", difficulty: "advanced", exampleEn: "I stock up on snacks monthly.", dims: ["shopping-list", "habits"] },
  ],
  科学: [
    { display: "science is everywhere in daily life", meaningZh: "科学无处不在", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "Science is everywhere in daily life.", dims: ["real-life", "application"] },
  ],
  唱歌: [
    { display: "can't carry a tune", meaningZh: "五音不全", unitType: "idiom", difficulty: "advanced", exampleEn: "I can't carry a tune at all.", dims: ["singing-ability", "ability"] },
  ],
  建筑购物: [
    { display: "what makes it interesting", meaningZh: "它的有趣之处", unitType: "sentence_frame", difficulty: "intermediate", exampleEn: "What makes it interesting is the mix of old and new.", dims: ["interesting-point", "features"] },
  ],
  种菜收获: [
    { display: "share the harvest", meaningZh: "分享收成", unitType: "collocation", difficulty: "intermediate", exampleEn: "We share the harvest with the neighbors.", dims: ["harvest", "sharing"] },
  ],
  体育赛事: [
    { display: "a live match", meaningZh: "现场比赛", unitType: "collocation", difficulty: "basic", exampleEn: "Nothing beats a live match.", dims: ["event", "atmosphere"] },
  ],
  发小: [
    { display: "we still hang out", meaningZh: "我们现在还一起玩", unitType: "lexical_chunk", difficulty: "intermediate", exampleEn: "We still hang out every month.", dims: ["now", "contact"] },
  ],
  禁手机: [
    { display: "a no-phone rule", meaningZh: "禁用手机的规定", unitType: "collocation", difficulty: "intermediate", exampleEn: "We have a no-phone rule at dinner.", dims: ["rule", "phone-ban"] },
  ],
};
