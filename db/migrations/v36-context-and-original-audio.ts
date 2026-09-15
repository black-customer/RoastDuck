import {V36_CONTEXT_DDL} from '../v36-context';
import {V36_COACHING_DDL} from '../v36-coaching';
import {V36_AUDIO_DDL} from '../v36-audio';
export const V36_DDL:string[]=[...V36_CONTEXT_DDL,...V36_COACHING_DDL,...V36_AUDIO_DDL,
  `ALTER TABLE user_settings ADD COLUMN speech_preferences_json TEXT`,
];
