"use client";

import { useEffect, useRef } from "react";
import { type VoicePresetId } from "@/lib/speech/contracts";
import { getTTS } from "@/lib/tts";
import {legacyPresetFor} from '@/lib/speech/preferences';
import {SpeechPreferences} from './SpeechPreferences';

interface VoiceSelectorProps {
  currentVoice?: VoicePresetId;
  onVoiceChange?: (voiceId: VoicePresetId) => void;
  compact?: boolean;
}

export function VoiceSelector({ currentVoice, onVoiceChange, compact = false }: VoiceSelectorProps) {
  const previousControlled=useRef(currentVoice);
  useEffect(() => {
    // A legacy controlled caller may change its preset explicitly. Initial props
    // must not overwrite a v3 speaker (Dean and Milo share the old male alias).
    if(currentVoice&&previousControlled.current!==currentVoice&&getTTS().getVoice()!==currentVoice)getTTS().setVoice(currentVoice);
    previousControlled.current=currentVoice;
  },[currentVoice]);
  return <SpeechPreferences compact={compact} onChange={preferences=>onVoiceChange?.(legacyPresetFor(preferences))}/>;
}

