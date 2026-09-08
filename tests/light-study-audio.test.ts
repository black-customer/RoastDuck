import { expect,it,vi } from "vitest";
import { LightAudioPlayer,type LightAudioState } from "@/lib/light-study/audio";
import type { TTSProvider } from "@/lib/tts";
const input=(text:string)=>({text,voiceId:"us-female" as const});
function setup(fetcher:typeof fetch){
  const fallback:TTSProvider={name:"test",speak:vi.fn(),stop:vi.fn(),setVoice:vi.fn(),getVoice:()=>"us-female"};
  const states:LightAudioState[]=[];
  const audio={play:vi.fn(async()=>undefined),pause:vi.fn(),onended:null as null|(()=>void),onerror:null as null|(()=>void)};
  const factory=vi.fn(()=>audio as unknown as HTMLAudioElement);
  return {player:new LightAudioPlayer(fallback,s=>states.push(s),fetcher,factory),fallback,states,audio,factory};
}
const success=()=>new Response(JSON.stringify({audio:{audioUrl:"/api/speech/assets/audio_test"}}));
it("当前和下一项提交不同优先级，同内容共享请求且播放结束复位",async()=>{
  const resolvers:Array<(r:Response)=>void>=[];
  const fetcher=vi.fn(()=>new Promise<Response>(resolve=>resolvers.push(resolve)));
  const {player,audio,states}=setup(fetcher);
  player.prime(input("one"),input("two"));
  const play=player.play(input("one"));
  await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));
  resolvers[0](success());await play;
  resolvers[1](success());
  await player.play(input("one"));expect(fetcher).toHaveBeenCalledTimes(2);
  audio.onended?.();expect(states.at(-1)).toMatchObject({phase:"idle",provider:"mimo"});player.dispose();
});
it("切换后跳过旧的排队预取，迟到响应不能播放",async()=>{
  let resolve!:(r:Response)=>void;
  const fetcher=vi.fn().mockImplementationOnce(()=>new Promise<Response>(r=>{resolve=r;})).mockImplementation(async()=>success());
  const {player,factory,fallback}=setup(fetcher);
  player.prime(input("old"),input("obsolete"));
  const play=player.play(input("old"));await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));
  player.stop();player.prime(input("new"),null);resolve(success());await play;
  await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(3));
  expect(JSON.parse(fetcher.mock.calls[2][1].body).text).toBe("new");
  expect(factory).not.toHaveBeenCalled();expect(fallback.speak).not.toHaveBeenCalled();player.dispose();
});
it("合成失败明确浏览器来源，并保留明确口音/声线；停止后旧回调无效",async()=>{
  const {player,fallback,states}=setup(vi.fn(async()=>new Response("{}",{status:503})));
  await player.play({text:"hello",voiceId:"uk-male"});
  expect(fallback.speak).toHaveBeenCalledWith("hello",expect.objectContaining({voiceId:"uk-male",lang:"en-GB"}));
  const opts=vi.mocked(fallback.speak).mock.calls[0][1]!;
  expect(states.at(-1)).toMatchObject({provider:"browser"});player.stop();opts.onEnd?.();
  expect(states.at(-1)).toMatchObject({phase:"idle",provider:null});player.dispose();
});
it("自动播放被拒绝可手动重播缓存，不冒充已经播放",async()=>{
  const fetcher=vi.fn(async()=>success());const {player,audio,states,fallback}=setup(fetcher);
  audio.play.mockRejectedValueOnce(new DOMException("blocked","NotAllowedError"));
  await player.play(input("hello"));expect(states.at(-1)?.phase).toBe("blocked");expect(fallback.speak).not.toHaveBeenCalled();
  await player.play(input("hello"));expect(fetcher).toHaveBeenCalledTimes(1);expect(states.at(-1)?.phase).toBe("playing");player.dispose();
});
it("卸载后请求和回调不能发声，关闭预取时不消费音频请求",async()=>{
  const fetcher=vi.fn(async()=>success());const {player,factory}=setup(fetcher);
  player.prime(input("one"),input("two"),false);await Promise.resolve();expect(fetcher).not.toHaveBeenCalled();
  player.dispose();await player.play(input("one"));expect(factory).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
});
