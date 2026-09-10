import { expect, it } from 'vitest';
import { speechSynthesisInputSchema, SPEECH_STYLES } from '@/lib/speech/contracts';
import { buildMimoBody, speechContentHash } from '@/lib/speech/wire';
import { webAudioKey } from '@/lib/speech/request-service';

it('three approved conversational directions preserve the original text, accent, and voice',()=>{
  const text="Well, I used to think that.\nI mean, it's changed... honestly.";
  const instructions=SPEECH_STYLES.map(style=>{
    const input=speechSynthesisInputSchema.parse({text,style,voice:'Dean',accent:'en-US'});
    const body=buildMimoBody(input,'Dean');
    expect(body.messages[1]).toEqual({role:'assistant',content:text});
    expect(body.audio).toEqual({format:'wav',voice:'Dean'});
    expect(body.messages[0].content).toContain('General American English');
    expect(body.messages[0].content).toContain('young adult chatting with a peer');
    expect(body.messages[0].content).toContain('lightly brisk');
    expect(body.messages[0].content).toContain('do not deliberately lower the pitch');
    expect(body.messages[0].content).toContain('preserving every word and existing filler exactly');
    return body.messages[0].content;
  });
  expect(new Set(instructions).size).toBe(3);
  expect(instructions[1]).toContain('light reductions on unstressed words');
  expect(instructions[2]).toContain('thoughtful but unpolished conversational rhythm');
  expect(()=>speechSynthesisInputSchema.parse({text,style:'invented-style'})).toThrow();
});

it('cache keys reflect the actual voice and prosody while equivalent purpose/rate requests share audio',()=>{
  const input={...speechSynthesisInputSchema.parse({text:'That sounds good.',voice:'Dean'}),voice:'Dean' as const};
  const same={...input,purpose:'chunk' as const,rate:1,style:'short-expression' as const};
  expect(webAudioKey(input)).toBe(webAudioKey(same));
  expect(speechContentHash(input,'Dean')).toBe(speechContentHash(same,'Dean'));
  expect(webAudioKey(input)).not.toBe(webAudioKey({...input,voice:'Chloe'}));
  expect(webAudioKey(input)).not.toBe(webAudioKey({...input,style:'ielts-answer'}));
  expect(webAudioKey(input)).not.toBe(webAudioKey({...input,accent:'en-GB'}));
  expect(webAudioKey(input)).not.toBe(webAudioKey({...input,rate:.7}));
});
