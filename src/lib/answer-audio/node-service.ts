import { nodeDatabase } from '@/lib/platform/node/database';
import fs from 'node:fs/promises';
import { createFullAnswerService } from '@/lib/full-answer-attempts/service';
import { createAnswerAudioService } from './service';
import { answerAudioRoot, audioAssetPath } from './storage';
const identity = createFullAnswerService(nodeDatabase);
export const fullAnswers = {
  sourceLink: identity.sourceLink,
  async history(questionId: string) {
    const view = await identity.history(questionId), root = answerAudioRoot();
    await Promise.all(view.attempts.flatMap(a => a.audio.map(async asset => {
      if (asset.purgedAt) return;
      try { const stat = await fs.lstat(audioAssetPath(root, asset.id, asset.extension)); asset.unavailable = !stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.byteLength; }
      catch { asset.unavailable = true; }
    })));
    return view;
  },
};
export const answerAudio = createAnswerAudioService(nodeDatabase, answerAudioRoot);
