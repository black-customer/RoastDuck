import {afterEach,expect,it,vi} from "vitest";
import {webLightClient} from "../src/lib/light-study/web-client";
afterEach(()=>vi.unstubAllGlobals());
it("desktop client preserves conflict codes for explicit latest-state recovery",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({error:"已有更新",code:"version_conflict"}),{status:409})));
  await expect(webLightClient.event("session",{type:"reveal",version:1,clientEventId:"stable"})).rejects.toMatchObject({status:409,code:"version_conflict"});
});
it("desktop adapter keeps scope binding and request identifiers, with no generated replacement on retry",async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({session:{id:"same"}})));vi.stubGlobal("fetch",fetch);
  const input={scope:{type:"question" as const,id:"问题/1"},mode:"learn" as const,clientRequestId:"kept"};
  expect(await webLightClient.create(input)).toEqual({id:"same"});
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(input);
  fetch.mockResolvedValue(new Response(JSON.stringify({overview:{totalCount:1}})));
  await webLightClient.overview(input.scope);
  expect(fetch.mock.calls[1][0]).toContain(encodeURIComponent("问题/1"));
});
