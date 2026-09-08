"use client";

import { useEffect, useState } from "react";
import { type VoicePresetId, VOICE_PRESETS } from "@/lib/speech/contracts";
import { getTTS } from "@/lib/tts";

interface VoiceSelectorProps {
  currentVoice?: VoicePresetId;
  onVoiceChange?: (voiceId: VoicePresetId) => void;
  compact?: boolean;
}

export function VoiceSelector({ currentVoice, onVoiceChange, compact = false }: VoiceSelectorProps) {
  const [selectedVoice, setSelectedVoice] = useState<VoicePresetId>(
    currentVoice ?? "us-female",
  );

  useEffect(() => {
    if (typeof window !== "undefined") {
      const active = getTTS().getVoice();
      setSelectedVoice(active);
    }
  }, []);

  useEffect(() => {
    if (currentVoice && currentVoice !== selectedVoice) {
      setSelectedVoice(currentVoice);
    }
  }, [currentVoice, selectedVoice]);

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value as VoicePresetId;
    setSelectedVoice(val);
    getTTS().setVoice(val);
    onVoiceChange?.(val);
  }

  return (
    <div className={`voice-selector ${compact ? "is-compact" : ""}`}>
      <label htmlFor="voice-preset-select" className="voice-selector-label">
        <span className="voice-icon">🎙️</span>
        {!compact ? <span className="voice-text">发音：</span> : null}
      </label>
      <select
        id="voice-preset-select"
        className="voice-select-dropdown"
        value={selectedVoice}
        onChange={handleChange}
        title="选择朗读与口语对练音色"
      >
        {VOICE_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label} · {preset.accent === "en-US" ? "🇺🇸 美音" : "🇬🇧 英音"}
          </option>
        ))}
      </select>
    </div>
  );
}

