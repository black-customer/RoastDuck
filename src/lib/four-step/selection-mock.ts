import type { MockAiResolver } from "@/lib/ai/mock-provider";
import { diagnosisSchema, type Diagnosis, type MaterialEvidence } from "./selection-contracts";

/** 明确的合成回归夹具，不是规则诊断器，也不用于私人内容发布。 */
export const selectionMockResolver:MockAiResolver=(request)=>{
  const input=JSON.parse(request.input);
  const schemaName=request.schemaName.replace(/_v3$/,'_v2'),spoken=request.schemaName.endsWith('_v3');
  if(schemaName==="four_step_diagnosis_v2") {
    const {actualAnswer:answer,intendedMeaningZh:meaning}=input.source as {actualAnswer:string;intendedMeaningZh:string};
    const noun=answer.includes("井盖") || /round metal (thing|cover)/i.test(answer);
    const missing=meaning.includes("化学") && !answer.includes("chemistry");
    const grammar=answer.includes("used to live alone");
    const preparation=spoken&&(!answer.trim()||input.source.inputFormat==='mixed-v1'&&/[\u3400-\u9fff]/u.test(answer))&&!noun&&!grammar&&!missing;
    const natural= !(noun || missing || grammar || preparation);
    const gaps:Diagnosis["units"][number]["gaps"]=noun ? [{id:"gap_manhole",kind:"lexical_gap",cueZh:"井盖",targetEnglish:"manhole cover",acceptableVariants:[],evidenceQuote:answer,whyNeededZh:"合成样例中用户明确缺少井盖的词语。"}]
      : grammar ? [{id:"gap_used_to",kind:"grammar_gap",cueZh:"已经习惯做某事",targetEnglish:"be used to doing",acceptableVariants:[],evidenceQuote:"used to live alone",whyNeededZh:"be used to 后接动名词，不把已经会用的 live alone 单独制卡。"}]
      : missing ? [{id:"gap_year",kind:"unexpressed_intention",cueZh:"大四学生",targetEnglish:"fourth-year student",acceptableVariants:[],evidenceQuote:meaning,whyNeededZh:"中文意图中的具体年级尚未表达。"},{id:"gap_major",kind:"unexpressed_intention",cueZh:"转专业",targetEnglish:"switch majors",acceptableVariants:[],evidenceQuote:meaning,whyNeededZh:"中文意图中的转专业经历尚未表达。"}]
      : preparation?[{id:'gap_lunch',kind:'unexpressed_intention',cueZh:'准备午饭',targetEnglish:'make lunch',acceptableVariants:[],evidenceQuote:answer||meaning,whyNeededZh:'原创测试的中文准备意思，尚未展示英文能力，不是确认错误。'}]:[];
    return diagnosisSchema.parse({units:[{id:"unit_1",english:answer&&!preparation?[{text:answer,occurrence:0}]:[],chinese:meaning?[{text:meaning,occurrence:0}]:[],...(input.source.inputFormat==='mixed-v1'?{raw:[{text:input.source.rawInput,occurrence:0}]}:{}),
      intentZh:meaning || (noun?"我在外面看到了一个井盖。":grammar?"我已经习惯一个人住了。":"这是原回答的合成中译测试。"),
      status:natural?"natural":missing||preparation?"missing":"repair",reasonZh:"隔离回归样例的指定诊断。",gaps:gaps.map(g=>({...g,...(spoken?{senseKey:g.id}:{})}))}]});
  }
  if(schemaName==="four_step_selection_v2") {
    const diagnosis=input.diagnosis as Diagnosis;
    return {approved:true,reasonZh:"独立请求中的合成裁决。",units:diagnosis.units.map((u)=>({unitId:u.id,status:u.status,evidenceQuote:[...u.english,...u.chinese,...u.raw??[]][0].text,reasonZh:"仅用于隔离测试的分类。"})),gaps:diagnosis.units.flatMap((u)=>u.gaps.map((g)=>({gapId:g.id,decision:"train",evidenceQuote:g.evidenceQuote,reasonZh:g.whyNeededZh})))};
  }
  if(schemaName==="four_step_material_v2") {
    const diagnosis=input.diagnosis as Diagnosis;
    const units=diagnosis.units.filter((u)=>!["uncertain","non_answer"].includes(input.selection.units.find((r:{unitId:string})=>r.unitId===u.id).status));
    const sentences=units.map((u,i)=>{
      const accepted = u.gaps.filter((g)=>input.selection.gaps.some((r:{gapId:string;decision:string})=>r.gapId===g.id && r.decision==="train"));
      let english=u.english.map((q)=>q.text).join(" ") || u.intentZh;
      if(accepted.some((g)=>g.id==="gap_manhole")) english=english.includes("井盖")?english.replaceAll("井盖","manhole cover"):"It's a round metal cover over a hole in the road: a manhole cover.";
      if(input.source.inputFormat==='mixed-v1'&&accepted.some(g=>g.id==='gap_manhole'))english='I saw a manhole cover outside.';
      if(accepted.some((g)=>g.id==="gap_major")) english="I'm a fourth-year student in Qingdao, studying computer science after I switched majors from chemistry.";
      if(accepted.some((g)=>g.id==="gap_used_to")) english=english.replace("used to live alone","used to living alone");
      if(accepted.some(g=>g.id==='gap_lunch'))english='I make lunch at home.';
      return {id:`sentence_${i}`,intentUnitIds:[u.id],english};
    });
    const rows=units.flatMap((u,i)=>u.gaps.filter((g)=>input.selection.gaps.some((r:{gapId:string;decision:string})=>r.gapId===g.id&&r.decision==="train")).map((g)=>({gapId:g.id,sentenceId:`sentence_${i}`,surfaceInSentence:g.id==="gap_major"?"switched majors":g.id==="gap_used_to"?"used to living":g.targetEnglish})));
    return {sentences,rows,examFeedback:input.source.mode==="exam_style"?{transcriptBasedNotice:"合成测试仅依据文本，不能评价发音或语调。",lexicalResource:"合成文本反馈。",grammaticalRange:"合成文本反馈。",coherence:"合成文本反馈。",paraphrasing:"释义表达传达了部分原意。",strengths:["Paraphrasing 释义能力"],weaknesses:[],approximateBand:null}:null};
  }
  if(schemaName==="four_step_review_v2") {
    const evidence=input.compiled.evidence as MaterialEvidence;
    const confirmed=(id:string)=>evidence.diagnosis.units.find(u=>u.gaps.some(g=>g.id===id))?.status==='repair';
    return {approved:true,reasonZh:"独立材料审核合成夹具。",rows:evidence.draft.rows.map((r)=>({gapId:r.gapId,approved:true,evidenceQuote:evidence.diagnosis.units.flatMap((u)=>u.gaps).find((g)=>g.id===r.gapId)!.evidenceQuote,reasonZh:"仅供测试：引用当前准备或修复目标。",repairNeeded:spoken?confirmed(r.gapId):true,...(spoken?{learningTargetNeeded:true}:{}),meaningPreserved:true,minimalRepair:true,cueUnambiguous:true,sentenceAligned:true,clozeValid:true})),...(spoken?{wholeAnswer:{meaningPreserved:true,voicePreserved:true,stancePreserved:true,discourseFunctionsPreserved:true,metaphorsPreserved:true,spokenNaturalness:true,noInventedPersonalStyle:true,reasonZh:'独立请求的合成全文核查。',evidence:input.compiled.naturalVersion?[{sourceField:input.source.actualAnswer?'actualAnswer':'intendedMeaningZh',sourceQuote:(input.source.actualAnswer||input.source.intendedMeaningZh).slice(0,1500),rendering:input.compiled.naturalVersion,treatment:'adapted',reasonZh:'合成案例保留原意。'}]:[]}}:{})};
  }
  throw new Error("unknown_selection_mock_schema");
};
