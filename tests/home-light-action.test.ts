import { expect,it } from "vitest";
import { chooseHomeLightAction } from "../src/lib/home/light-action";
it("home resumes the latest scoped session before due/new; disabled new entry still permits recovery",()=>{
  const latest={scope:{type:"question" as const,id:"question-1"},mode:"learn" as const};
  expect(chooseHomeLightAction({enabled:false,dueCount:2,newCount:5},latest)).toEqual({kind:"resume",label:"继续上次学习",...latest});
});
it("due precedes new, empty/disabled points to a real new-answer action",()=>{
  expect(chooseHomeLightAction({enabled:true,dueCount:2,newCount:5},null).kind).toBe("review");
  expect(chooseHomeLightAction({enabled:true,dueCount:0,newCount:5},null).kind).toBe("learn");
  expect(chooseHomeLightAction({enabled:true,dueCount:0,newCount:0},null).kind).toBe("question");
  expect(chooseHomeLightAction({enabled:false,dueCount:2,newCount:5},null).kind).toBe("question");
});
