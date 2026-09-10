import {randomUUID} from 'node:crypto';
import {nodeDatabase} from '@/lib/platform/node/database';
import {createSentenceHighlights} from './highlights-service';
export const sentenceHighlights=createSentenceHighlights(nodeDatabase,{now:()=>new Date(),newId:randomUUID});
