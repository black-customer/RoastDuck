import assert from "node:assert/strict";
import { compileEvidence, diagnosisSchema, locateQuote, validateEvidenceReview, type MaterialEvidence } from "../../src/lib/four-step/selection-contracts";
import { buildTasks } from "../../src/lib/four-step/contracts";

/** 人工编写的合成正反例，不含私人正文；检查选材契约，不冒充真实模型语义评测。 */
export function selectionFixture() {
  const source={actualAnswer:"I'm used to live alone. I really like my major.",intendedMeaningZh:"我已经习惯一个人住了。我很喜欢我的专业。"};
  const diagnosis=diagnosisSchema.parse({units:[
    {id:"u1",intentZh:"我已经习惯一个人住了。",english:[{text:"I'm used to live alone."}],chinese:[{text:"我已经习惯一个人住了。"}],status:"repair",reasonZh:"动名词构式用错。",gaps:[{id:"g1",kind:"grammar_gap",cueZh:"已经习惯做某事",targetEnglish:"be used to doing",acceptableVariants:[],evidenceQuote:"used to live alone",whyNeededZh:"be used to 后应接动名词；live alone 本身已会表达。"}]},
    {id:"u2",intentZh:"我很喜欢我的专业。",english:[{text:"I really like my major."}],chinese:[{text:"我很喜欢我的专业。"}],status:"natural",reasonZh:"自然表达，无需升级为 passionate about。",gaps:[]},
  ]});
  const evidence:MaterialEvidence={diagnosis,selection:{approved:true,reasonZh:"按原意逐项核查。",units:diagnosis.units.map((u)=>({unitId:u.id,status:u.status,evidenceQuote:u.english[0].text,reasonZh:u.reasonZh})),gaps:[{gapId:"g1",decision:"train",evidenceQuote:"used to live alone",reasonZh:"需要修复 be used to + doing 构式，不训练已会的 live alone。"}]},draft:{sentences:[{id:"s1",intentUnitIds:["u1"],english:"I'm used to living alone."},{id:"s2",intentUnitIds:["u2"],english:"I really like my major."}],rows:[{gapId:"g1",sentenceId:"s1",surfaceInSentence:"used to living"}],examFeedback:null}};
  const review={approved:true,reasonZh:"逐行审核当前原句。",rows:[{gapId:"g1",approved:true,evidenceQuote:"used to live alone",reasonZh:"只修复动名词构式。",repairNeeded:true,meaningPreserved:true,minimalRepair:true,cueUnambiguous:true,sentenceAligned:true,clozeValid:true}]};
  return {source,evidence,review};
}
export function runSelectionGolden() {
  const results:Array<{id:string;ok:boolean;error?:string}>=[];
  function check(id:string,work:(fixture:ReturnType<typeof selectionFixture>)=>void) {
    try {work(selectionFixture());results.push({id:`selection-v2-${id}`,ok:true});}
    catch(error) {results.push({id:`selection-v2-${id}`,ok:false,error:error instanceof Error?error.message:"失败"});}
  }
  check("construction-not-known-context",({source,evidence})=>{const a=compileEvidence(source,evidence);assert.deepEqual(a.learningMaterials.map((r)=>r.englishChunk),["be used to doing"]);assert.equal(a.learningMaterials[0].yourChineseSentence,"我已经习惯一个人住了。");});
  check("natural-preserved-not-trained",({source,evidence})=>{const a=compileEvidence(source,evidence);assert.ok(a.naturalVersion.endsWith("I really like my major."));assert.equal(a.learningMaterials.length,1);});
  check("whole-intention-not-just-gap",({source,evidence})=>assert.equal(compileEvidence(source,evidence).answerIntentZh,"我已经习惯一个人住了。\n我很喜欢我的专业。"));
  check("inflected-span-not-frame",({source,evidence})=>{const a=compileEvidence(source,evidence);const tasks=buildTasks(a.learningMaterials,a.naturalVersion,a.answerIntentZh);assert.equal(tasks[2][0].answer,"used to living");assert.equal(tasks[0][0].answer,"be used to doing");});
  check("style-upgrade-rejected",({source,evidence})=>{evidence.draft.sentences[1].english="I'm passionate about my major.";assert.throws(()=>compileEvidence(source,evidence));});
  check("reviewer-excludes-candidate",({source,evidence})=>{evidence.selection.gaps[0].decision="exclude";evidence.draft.rows=[];assert.equal(compileEvidence(source,evidence).learningMaterials.length,0);});
  check("uncertain-not-input-audio",({source,evidence})=>{evidence.selection.units[0].status="uncertain";evidence.selection.gaps[0].decision="uncertain";evidence.draft.sentences.shift();evidence.draft.rows=[];const a=compileEvidence(source,evidence);assert.equal(a.gapCount,0);assert.equal(a.naturalVersion,"I really like my major.");});
  check("unreviewed-row-rejected",({source,evidence})=>{evidence.selection.gaps[0].decision="exclude";assert.throws(()=>compileEvidence(source,evidence));});
  check("natural-selected-rejected",({source,evidence})=>{evidence.selection.units[0].status="natural";assert.throws(()=>compileEvidence(source,evidence));});
  check("missing-raw-coverage",({source,evidence})=>{evidence.diagnosis.units[1].english=[];assert.throws(()=>compileEvidence(source,evidence));});
  check("invented-source-quote",({source,evidence})=>{evidence.diagnosis.units[0].chinese[0].text="我想搬到美国。";assert.throws(()=>compileEvidence(source,evidence));});
  check("wrong-sentence-link",({source,evidence})=>{evidence.draft.rows[0].sentenceId="s2";assert.throws(()=>compileEvidence(source,evidence));});
  check("missing-cloze-surface",({source,evidence})=>{evidence.draft.rows[0].surfaceInSentence="be used to doing";assert.throws(()=>compileEvidence(source,evidence));});
  check("unchanged-repair-rejected",({source,evidence})=>{evidence.draft.sentences[0].english="I'm used to live alone.";evidence.draft.rows[0].surfaceInSentence="used to live";assert.throws(()=>compileEvidence(source,evidence));});
  check("duplicate-meaning-rejected",({source,evidence})=>{evidence.draft.sentences[1].intentUnitIds.push("u1");assert.throws(()=>compileEvidence(source,evidence));});
  check("review-requires-current-evidence",({evidence,review})=>{review.rows[0].evidenceQuote="unrelated answer";assert.throws(()=>validateEvidenceReview(evidence,review));});
  check("review-no-need-no-publication",({evidence,review})=>{review.rows[0].repairNeeded=false;assert.throws(()=>validateEvidenceReview(evidence,review));});
  check("review-chinese-mismatch-rejects",({evidence,review})=>{review.rows[0].meaningPreserved=false;assert.throws(()=>validateEvidenceReview(evidence,review));});
  check("repeat-quote-offset",()=>assert.deepEqual(locateQuote("好。好。",{text:"好。",occurrence:1}),{start:2,end:4}));
  check("all-uncertain-no-fake-sentence",({source,evidence})=>{evidence.selection.units.forEach((u)=>u.status="uncertain");evidence.selection.gaps[0].decision="uncertain";evidence.draft={sentences:[],rows:[],examFeedback:null};const a=compileEvidence(source,evidence);assert.equal(a.naturalVersion,"");assert.equal(a.gapCount,0);});
  return results;
}
