import { afterEach,expect,it,vi } from "vitest";
import { LightAudioPlayer,type LightAudioState } from "@/lib/light-study/audio";
import type { TTSProvider } from "@/lib/tts";
const input=(text:string)=>({text,voiceId:"us-female" as const});
const players:LightAudioPlayer[]=[];
afterEach(()=>{players.splice(0).forEach(player=>player.dispose());vi.useRealTimers();vi.restoreAllMocks();});
function wave(){const bytes=new Uint8Array(64);bytes.set([82,73,70,70],0);bytes.set([87,65,86,69],8);return new Response(bytes,{headers:{'content-type':'audio/wav'}});}
function setup(synthesis:typeof fetch,asset:typeof fetch=vi.fn(async()=>wave())){
  const fetcher=vi.fn((url:string|URL|Request,init?:RequestInit)=>String(url)==='/api/speech/synthesis'?synthesis(url,init):asset(url,init));
  const fallback:TTSProvider={name:"test",speak:vi.fn(),stop:vi.fn(),setVoice:vi.fn(),getVoice:()=>"us-female"};
  const states:LightAudioState[]=[];
  const audio={play:vi.fn(async()=>undefined),pause:vi.fn(),onended:null as null|(()=>void),onerror:null as null|(()=>void)};
  const factory=vi.fn((url:string)=>{void url;return audio as unknown as HTMLAudioElement;});
  const player=new LightAudioPlayer(fallback,s=>states.push(s),fetcher,factory);players.push(player);
  return {player,fallback,states,audio,factory,fetcher,asset};
}
const success=(voice='Chloe')=>new Response(JSON.stringify({audio:{audioUrl:"/api/speech/assets/audio_test",voice}}));
it('默认fetch保留浏览器global receiver，不在发送前发生Illegal invocation',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(function(this:unknown,url){
    if(this!==globalThis)throw new TypeError('Illegal invocation');
    return Promise.resolve(String(url).includes('/synthesis')?success():wave());
  });
  const fallback:TTSProvider={name:'test',speak:vi.fn(),stop:vi.fn(),setVoice:vi.fn(),getVoice:()=> 'us-female'};
  const audio={play:vi.fn(async()=>undefined),pause:vi.fn(),onended:null,onerror:null};
  const player=new LightAudioPlayer(fallback,()=>undefined,undefined,()=>audio as unknown as HTMLAudioElement);players.push(player);
  await player.play(input('A browser binding regression fixture.'));
  expect(fetcher).toHaveBeenCalledTimes(2);expect(audio.play).toHaveBeenCalledOnce();expect(fallback.speak).not.toHaveBeenCalled();
});
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

it("当前和下一项真正下载 WAV，重播使用内存资源，换项和卸载释放对象地址",async()=>{
  const revoke=vi.spyOn(URL,'revokeObjectURL');
  const synthesis=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{void url;void init;return success('Dean');});
  const {player,asset,factory}=setup(synthesis);
  const current={text:'I mean, that works.',voiceId:'us-male' as const,style:'short-expression' as const};
  const next={...current,text:'That sounds good.'};
  player.prime(current,next);
  await vi.waitFor(()=>expect(asset).toHaveBeenCalledTimes(2));
  await player.play(current);await player.play(current);
  expect(synthesis).toHaveBeenCalledTimes(2);expect(asset).toHaveBeenCalledTimes(2);
  expect(factory.mock.calls[0]?.[0]).toMatch(/^blob:/);
  expect(JSON.parse(String(synthesis.mock.calls[0]?.[1]?.body))).toMatchObject({voice:'Dean',style:'short-expression'});
  player.stop();player.prime(next,null,false);
  expect(revoke).toHaveBeenCalledTimes(1);
  player.dispose();expect(revoke).toHaveBeenCalledTimes(2);
});

it("同文不同声线和风格分别准备，响应不符声线不能冒充所选示范",async()=>{
  const synthesis=vi.fn(async(_url:string|URL|Request,init?:RequestInit)=>success(JSON.parse(String(init?.body)).voice));
  const {player,asset,states}=setup(synthesis);
  await player.play({...input('Well, it helps.'),style:'daily-conversation'});
  await player.play({...input('Well, it helps.'),style:'ielts-answer'});
  await player.play({text:'Well, it helps.',voiceId:'us-male',style:'ielts-answer'});
  expect(synthesis).toHaveBeenCalledTimes(3);expect(asset).toHaveBeenCalledTimes(3);
  expect(states.at(-1)).toMatchObject({provider:'mimo',voice:'Dean'});
  const mismatch=setup(vi.fn(async()=>success('Chloe')));
  await mismatch.player.play({text:'Hello.',voiceId:'us-male'});
  expect(mismatch.asset).not.toHaveBeenCalled();expect(mismatch.states.at(-1)).toMatchObject({provider:'browser',errorCode:'invalid_audio'});
});

it("换项取消实际资源下载，忽略迟到音频且不保留对象地址",async()=>{
  let resolve!:(response:Response)=>void;
  const asset=vi.fn((url:string|URL|Request,init?:RequestInit)=>{void url;void init;return new Promise<Response>(r=>{resolve=r;});});
  const create=vi.spyOn(URL,'createObjectURL');
  const {player,factory,fallback}=setup(vi.fn(async()=>success()),asset);
  const play=player.play(input('Old resource.'));
  await vi.waitFor(()=>expect(asset).toHaveBeenCalledOnce());
  player.stop();player.prime(null,null,false);expect(asset.mock.calls[0][1]?.signal?.aborted).toBe(true);
  resolve(wave());await play;
  expect(factory).not.toHaveBeenCalled();expect(fallback.speak).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();
});

it("揭晓前停止出声仍保留当前和下一项资源预取",async()=>{
  const synthesis=vi.fn(async()=>success());
  const {player,asset,factory}=setup(synthesis);
  player.prime(input('Current hidden.'),input('Next hidden.'));player.stop();
  await vi.waitFor(()=>expect(asset).toHaveBeenCalledTimes(2));
  expect(factory).not.toHaveBeenCalled();
  await player.play(input('Current hidden.'));
  expect(synthesis).toHaveBeenCalledTimes(2);expect(factory).toHaveBeenCalledOnce();
});

it("3.5秒冷请求自动备用，迟到结果只缓存，下次播放直接使用资源",async()=>{
  vi.useFakeTimers();let resolve!:(response:Response)=>void;
  const synthesis=vi.fn(()=>new Promise<Response>(r=>{resolve=r;}));
  const {player,fallback,factory}=setup(synthesis);
  const play=player.play(input('Late resource.'));
  await vi.advanceTimersByTimeAsync(3500);await play;
  expect(fallback.speak).toHaveBeenCalledOnce();expect(factory).not.toHaveBeenCalled();
  resolve(success());await vi.advanceTimersByTimeAsync(0);
  expect(factory).not.toHaveBeenCalled();
  await player.play(input('Late resource.'));
  expect(synthesis).toHaveBeenCalledOnce();expect(factory).toHaveBeenCalledOnce();
});

it("旧播放器卸载不能停掉其他播放器正在使用的系统备用声音",async()=>{
  const old=setup(vi.fn(async()=>new Response('{}',{status:503}))),current=setup(vi.fn(async()=>new Response('{}',{status:503})));
  await old.player.play(input('Old.'));await current.player.play(input('Current.'));
  vi.mocked(old.fallback.stop).mockClear();vi.mocked(current.fallback.stop).mockClear();
  old.player.dispose();
  expect(old.fallback.stop).not.toHaveBeenCalled();expect(current.fallback.stop).not.toHaveBeenCalled();
});
