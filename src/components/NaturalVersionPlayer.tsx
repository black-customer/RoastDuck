"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { getTTS, splitSentencesForTts } from "@/lib/tts";
import { VoiceSelector } from "./VoiceSelector";
import type {SpeechStyle} from '@/lib/speech/contracts';

type PlayMode = "continuous" | "loop_single" | "shadowing";

interface NaturalVersionPlayerProps {
  naturalVersion: string;
  style?:SpeechStyle;
}

export function NaturalVersionPlayer({ naturalVersion,style='daily-conversation' }: NaturalVersionPlayerProps) {
  const ownerId=useId();
  const sentences = useMemo(() => {
    const list = splitSentencesForTts(naturalVersion);
    return list.length > 0 ? list : [naturalVersion];
  }, [naturalVersion]);

  const [activeIndex, setActiveIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playMode, setPlayMode] = useState<PlayMode>("continuous");
  const [isShadowingWaiting, setIsShadowingWaiting] = useState(false);

  // References to keep event callbacks up to date
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const playModeRef = useRef(playMode);
  playModeRef.current = playMode;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const shadowingTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const playbackEpoch = useRef(0);
  const invalidatePlayback = useCallback(() => { playbackEpoch.current++; }, []);

  // Clean up audio & timers on unmount
  useEffect(() => {
    setActiveIndex(0);
    setIsPlaying(false);
    setIsShadowingWaiting(false);
    return () => {
      isPlayingRef.current = false;
      invalidatePlayback();
      getTTS().stop(ownerId);
      if (shadowingTimerRef.current) clearTimeout(shadowingTimerRef.current);
    };
  }, [naturalVersion, invalidatePlayback,ownerId]);

  function stopAll() {
    isPlayingRef.current = false;
    playbackEpoch.current++;
    if (shadowingTimerRef.current) {
      clearTimeout(shadowingTimerRef.current);
      shadowingTimerRef.current = null;
    }
    getTTS().stop(ownerId,true);
    setIsPlaying(false);
    setIsShadowingWaiting(false);
  }

  function playSentenceAt(index: number) {
    if (index < 0 || index >= sentences.length) {
      stopAll();
      return;
    }

    if (shadowingTimerRef.current) {
      clearTimeout(shadowingTimerRef.current);
      shadowingTimerRef.current = null;
    }

    setActiveIndex(index);
    const generation = ++playbackEpoch.current;
    isPlayingRef.current = true;
    setIsPlaying(true);
    setIsShadowingWaiting(false);

    const sentence = sentences[index];
    getTTS().speak(sentence, {
      ownerId,style,
      onEnd: () => {
        if (!isPlayingRef.current || playbackEpoch.current !== generation) return;

        const currentMode = playModeRef.current;
        if (currentMode === "loop_single") {
          // Loop current sentence with minimal gap
          shadowingTimerRef.current = setTimeout(() => {
            if (isPlayingRef.current && playbackEpoch.current === generation) {
              playSentenceAt(index);
            }
          }, 350);
        } else if (currentMode === "shadowing") {
          // Pause 2.5s to let user shadow, then advance
          setIsShadowingWaiting(true);
          shadowingTimerRef.current = setTimeout(() => {
            setIsShadowingWaiting(false);
            if (!isPlayingRef.current || playbackEpoch.current !== generation) return;
            if (index + 1 < sentences.length) {
              playSentenceAt(index + 1);
            } else {
              stopAll();
            }
          }, 2500);
        } else {
          // Continuous playback: go to next sentence
          if (index + 1 < sentences.length) {
            shadowingTimerRef.current = setTimeout(() => {
              if (isPlayingRef.current && playbackEpoch.current === generation) {
                playSentenceAt(index + 1);
              }
            }, 300);
          } else {
            stopAll();
          }
        }
      },
      onError: () => {
        if (playbackEpoch.current === generation) stopAll();
      },
    });
  }

  function handleTogglePlay() {
    if (isPlaying) {
      stopAll();
    } else {
      playSentenceAt(activeIndex);
    }
  }

  function handlePrev() {
    if (activeIndex > 0) {
      playSentenceAt(activeIndex - 1);
    }
  }

  function handleNext() {
    if (activeIndex + 1 < sentences.length) {
      playSentenceAt(activeIndex + 1);
    }
  }

  function handleSentenceClick(index: number) {
    if (isPlaying && activeIndex === index) {
      stopAll();
    } else {
      playSentenceAt(index);
    }
  }

  return (
    <section className="card natural-player-card">
      <div className="player-card-header">
        <div>
          <h2>Natural Version · 地道口语表达</h2>
          <small className="card-subtitle">
            母语者表达建议（点击任一句即可播放，支持单句循环与跟读）
          </small>
        </div>
        <VoiceSelector compact />
      </div>

      {/* Control Toolbar */}
      <div className="player-toolbar">
        <div className="transport-controls">
          <button
            type="button"
            className="transport-btn"
            onClick={handlePrev}
            disabled={activeIndex === 0}
            title="上一句"
          >
            ⏮️ 上一句
          </button>

          <button
            type="button"
            className={`transport-play-btn ${isPlaying ? "is-playing" : ""}`}
            onClick={handleTogglePlay}
          >
            {isPlaying ? "⏸️ 暂停" : "▶️ 播放"}
          </button>

          <button
            type="button"
            className="transport-btn"
            onClick={handleNext}
            disabled={activeIndex >= sentences.length - 1}
            title="下一句"
          >
            下一句 ⏭️
          </button>
        </div>

        {/* Playback Mode Toggles */}
        <div className="mode-pill-group">
          <button
            type="button"
            className={`mode-pill ${playMode === "continuous" ? "active" : ""}`}
            onClick={() => setPlayMode("continuous")}
            title="顺序连播全篇"
          >
            🔁 连播
          </button>
          <button
            type="button"
            className={`mode-pill ${playMode === "loop_single" ? "active" : ""}`}
            onClick={() => setPlayMode("loop_single")}
            title="单句无限循环播放"
          >
            🔂 单句循环
          </button>
          <button
            type="button"
            className={`mode-pill ${playMode === "shadowing" ? "active" : ""}`}
            onClick={() => setPlayMode("shadowing")}
            title="每句播完停顿 2.5 秒供跟读"
          >
            🗣️ 跟读停顿
          </button>
        </div>

        <div className="player-progress-badge">
          第 {activeIndex + 1} / {sentences.length} 句
        </div>
      </div>

      {/* Shadowing status prompt */}
      {isPlaying && isShadowingWaiting ? (
        <div className="shadowing-active-banner">
          <span className="shadowing-pulse">🎙️</span>
          <span>轮到你跟读了，试着用纯正语音复述刚刚这句...</span>
        </div>
      ) : null}

      {/* Sentence Cards (Lyric Style) */}
      <div className="sentence-list">
        {sentences.map((sent, idx) => {
          const isActive = idx === activeIndex;
          const isCurrentSpeaking = isActive && isPlaying && !isShadowingWaiting;
          const isCurrentShadowing = isActive && isPlaying && isShadowingWaiting;

          return (
            <div
              key={idx}
              className={`sentence-item ${isActive ? "is-active" : ""} ${isCurrentSpeaking ? "is-speaking" : ""} ${isCurrentShadowing ? "is-shadowing" : ""}`}
              onClick={() => handleSentenceClick(idx)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleSentenceClick(idx);
                }
              }}
            >
              <div className="sentence-num-badge">{idx + 1}</div>
              <div className="sentence-body">
                <p className="sentence-text" lang="en">
                  {sent}
                </p>
              </div>
              <div className="sentence-action">
                {isCurrentSpeaking ? (
                  <span className="playing-indicator" title="正在朗读">
                    🔊 朗读中
                  </span>
                ) : isCurrentShadowing ? (
                  <span className="shadowing-indicator" title="跟读中">
                    🗣️ 跟读中
                  </span>
                ) : (
                  <span className="play-icon-hint" title="播放此句">
                    ▶️
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

