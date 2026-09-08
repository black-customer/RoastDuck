import { sha256Text } from "@/lib/platform/hash";
import { MIMO_TTS_MODEL, MIMO_TTS_VERSION, resolveSpeechStyle, type SpeechStyle, type SpeechSynthesisInput } from "./contracts";

// Adapted from the approved B/C/D listening samples; the supplied text stays untouched.
const STYLE_DIRECTIONS: Record<SpeechStyle, string> = {
  "short-expression": "Say this short expression as part of a real conversation. Keep it compact and connected, with light reductions on unstressed words and emphasis only where the meaning needs it. Do not stretch each word or add a dramatic ending.",
  "daily-conversation": "You're casually talking to a friend or politely sorting something out in a real conversation. Sound relaxed, practical, and friendly, as if speaking spontaneously. Use connected conversational phrasing, light reductions on unstressed words, and varied phrase lengths. Let questions rise naturally; give dates, times, and meaningful contrasts enough emphasis to be clear. Existing fillers pass lightly, with brief listening or thinking pauses only where the supplied text calls for them.",
  "ielts-answer": "You're answering a person's question about your own experiences and views. Think aloud naturally, with a thoughtful but unpolished conversational rhythm. Vary the pace instead of giving every sentence the same rise and fall. Let existing opening words and clarifications pass gently, with brief pauses at changes of thought. Emphasize the meaning lightly and end matter-of-factly, not like an inspirational speech. No exaggerated breathiness or performative hesitation.",
};

export function buildMimoBody(input: SpeechSynthesisInput, voice: string) {
  const speed = input.rate < .85 ? "a little slower while keeping words connected" : input.rate > 1.08 ? "lively but still easy to follow" : "at a natural conversational pace";
  const accent = input.accent === "en-GB" ? "natural contemporary British English" : "natural contemporary General American English";
  const instruction = [
    STYLE_DIRECTIONS[resolveSpeechStyle(input)],
    `Speak in ${accent}, ${speed}.`,
    "No announcer cadence, teaching voice, sing-song intonation, or theatrical delivery. Clean close-microphone audio, no telephone filter or second voice.",
    "Speak only the supplied English text, preserving every word and existing filler exactly. Do not speak these instructions or add a preamble, extra filler words, explanations, other characters, or background sounds. Do not omit or rewrite content.",
  ].join(" ");
  return { model: MIMO_TTS_MODEL, messages: [{ role: "user", content: instruction }, { role: "assistant", content: input.text }], audio: { format: "wav", voice }, stream: false };
}

/** Identity follows the actual synthesis request, including voice and complete prosody instructions. */
export function audioDescriptor(input: SpeechSynthesisInput, voice: string) {
  return { version: MIMO_TTS_VERSION, request: buildMimoBody(input, voice) };
}
export const speechContentHash = (input: SpeechSynthesisInput, voice: string) => sha256Text(JSON.stringify(audioDescriptor(input, voice)));
