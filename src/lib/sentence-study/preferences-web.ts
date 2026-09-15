import {randomUUID} from 'node:crypto';
import {nodeDatabase} from '@/lib/platform/node/database';
import {createSentencePreferences} from './preferences';
export const sentencePreferences=createSentencePreferences(nodeDatabase,{now:()=>new Date(),newId:randomUUID});
