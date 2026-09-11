import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {portableTestDatabase} from './helpers/portable-db';
import {query as sql} from '@/lib/platform/sql';
import type {SqlReader} from '@/lib/platform/database';
import type {MaterialInput, MaterialRow} from '@/lib/four-step/material-types';
import type {SentenceCard} from '@/lib/sentence-study/contracts';
import {sentenceDisplayVersion, SENTENCE_VALIDATION_VERSION} from '@/lib/sentence-study/materials';
import {materialFingerprint} from '@/lib/light-study/core-catalogue';
import {sha256Text} from '@/lib/platform/hash';
import {highlightAnchor, projectStoredSentenceHighlights, type StoredSentenceHighlight} from '@/lib/sentence-study/highlights';
import {teachingCandidateHash, type TeachingAuthor, type TeachingReview, type SentenceTeaching} from '@/lib/sentence-study/teaching-contracts';
import {applyTeachingEdition, compileTeachingEdition, readTeachingAttachments, withTeaching} from '@/lib/sentence-study/teaching-editions';
import {applyTeachingSentenceRevision, compileTeachingSentenceRevision, teachingRevisionSchema} from '@/lib/sentence-study/teaching-revisions';

// All language and approval records below are original, explicitly synthetic fixtures.
// They test publication contracts, not linguistic approval of private learning content.
const stamp = '2026-09-11T00:00:00.000Z';
const opened: ReturnType<typeof portableTestDatabase>[] = [];
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Runtime/network is forbidden in this suite'));
});
afterEach(() => {
  for (const item of opened.splice(0)) item.close();
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

function teaching(chinese: string, english: string): SentenceTeaching {
  return {version: 'sentence-teaching-v1', overviewZh: '合成测试：用主语和动作表达一个完整意思。', parts: [{
    cueZh: chinese, quoteEn: english, explanationZh: '合成测试说明：这里先交代说话人，再描述行为或状态。',
    pattern: '', examples: [], alternatives: [], contrastZh: '',
  }]};
}

function fixture() {
  const input: MaterialInput = {
    sourceType: 'ielts_practice', sourceId: 'synthetic-attempt', mode: 'practice',
    question: {id: 'synthetic-question', textEn: 'What do you do in the evening?', textZh: '晚上做什么？', part: 1},
    actualAnswer: 'I read at night. I rest. That thing was strange.',
    intendedMeaningZh: '我晚上读书。我休息。那个东西很奇怪。',
  };
  const material: MaterialRow = {
    id: 'synthetic-material', contract_version: 'evidence_v2', source_type: 'ielts_practice',
    source_id: input.sourceId, question_id: input.question!.id, input_json: JSON.stringify(input),
    input_hash: 'synthetic-input', analysis_json: JSON.stringify({fixture: 'original synthetic analysis'}),
    status: 'ready', generator_run_id: 'synthetic-generator', reviewer_run_id: 'synthetic-reviewer',
    review_json: '{"fixture":true}', job_id: null, lease_until: null, lease_token: null,
    created_at: stamp, updated_at: stamp, error_code: null,
  };
  const sentences = [
    ['我晚上读书。', 'I read at night.'], ['我休息。', 'I rest.'], ['那个东西很奇怪。', 'That thing was strange.'],
  ];
  const cards: SentenceCard[] = sentences.map(([chinese, english], index) => {
    const usages: SentenceCard['usages'] = index === 0 ? [
      {id: 'retained', text: 'at night', meaningZh: '在晚上', kind: 'preparation', start: 7, end: 15},
      {id: 'obsolete', text: 'I read', meaningZh: '我读书', kind: 'confirmed_error', start: 0, end: 6},
    ] : [];
    const card: SentenceCard = {
      id: `synthetic-sentence-${index}`, version: '', materialId: material.id, sentenceId: `unit-${index}`,
      ordinal: index, chinese, english, contextZh: sentences[index - 1]?.[0] ?? '', meaningOrigin: 'user_chinese',
      usages, notes: index === 0 ? [
        {id: 'retained', kind: 'suggestion', textZh: 'at night表示晚上。', evidence: 'I read at night.'},
        {id: 'obsolete', kind: 'correction', textZh: '旧测试说明专门讲I read。', evidence: 'I read at night.'},
      ] : [],
      source: {type: 'ielts_practice', id: input.sourceId, questionId: input.question!.id, title: '合成晚间活动', href: '/questions/synthetic-question'},
      progressVersion: 0,
    };
    card.version = sentenceDisplayVersion(card);
    return card;
  });
  // sentenceDisplayVersion accepts a narrow type but serializes its whole argument;
  // mirror the production call's explicit projection, not additional card fields.
  for (const card of cards) card.version = sentenceDisplayVersion({
    materialId: card.materialId, chinese: card.chinese, english: card.english, contextZh: card.contextZh,
    meaningOrigin: card.meaningOrigin, usages: card.usages, notes: card.notes,
  });
  const author: TeachingAuthor = {
    materialId: material.id, sourceHash: sha256Text(material.input_json), analysisHash: sha256Text(material.analysis_json),
    authorContext: 'synthetic-author', runId: 'synthetic-author-run',
    sentences: cards.map(card => ({sentenceId: card.id, textVersion: card.version, teaching: teaching(card.chinese, card.english)})),
  };
  const review: TeachingReview = {
    candidateHash: teachingCandidateHash(author), reviewerContext: 'synthetic-independent-reviewer', runId: 'synthetic-review-run',
    approved: true, coverageReasonZh: '仅供结构测试的合成完整审核。',
    sentences: cards.map(card => ({sentenceId: card.id, approved: true, decision: 'ready', sourceQuote: card.english,
      reasonZh: '合成审核结果，不代表真实内容质量。', meaningCovered: true, naturalEnglish: true, teachingCorrect: true, examplesCorrect: true})),
  };
  return {input, material, cards, author, review};
}
type Fixture = ReturnType<typeof fixture>;
function resign(f: Fixture) { f.review.candidateHash = teachingCandidateHash(f.author); }
function revision(f: Fixture, v2 = true) {
  return teachingRevisionSchema.parse({version: 'sentence-teaching-revision-v1',
    ...(v2 ? {compilerVersion: 'exact-targets-v2'} : {}), parentEditionId: null,
    sourceCards: f.cards, author: f.author, review: f.review});
}
function correctedFixture() {
  const f = fixture(), english = 'I enjoy reading at night.';
  f.author.sentences[0].issue = {reasonZh: '合成修订：改变句子表达，保留晚上读书的意思。',
    suggestedChinese: f.cards[0].chinese, suggestedEnglish: english, correctedTeaching: teaching(f.cards[0].chinese, english)};
  resign(f); return f;
}
function partialFixture() {
  const f = fixture(), item = f.author.sentences[1];
  item.issue = {reasonZh: '合成不确定项，不作为正确示范。', needsConfirmation: true,
    suggestedChinese: f.cards[1].chinese, suggestedEnglish: f.cards[1].english, correctedTeaching: item.teaching};
  Object.assign(f.review, {approved: false, partialApproval: true});
  Object.assign(f.review.sentences[1], {approved: false, decision: 'needs_attention', meaningCovered: false,
    naturalEnglish: false, teachingCorrect: false, examplesCorrect: false});
  resign(f); return f;
}

async function seeded(f = correctedFixture()) {
  const db = portableTestDatabase(); opened.push(db);
  await db.database.write(async tx => {
    await tx.run(sql`INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('synthetic-question','retired',1,'What do you do in the evening?','晚上做什么？','synthetic')`);
    await tx.run(sql`INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status) VALUES('synthetic-attempt','synthetic-question','practice',${f.input.actualAnswer},${f.input.intendedMeaningZh},'completed')`);
    await tx.run(sql`INSERT INTO practice_materials(id,source_type,source_id,question_id,input_json,input_hash,analysis_json,status,contract_version,created_at,updated_at) VALUES(${f.material.id},'ielts_practice','synthetic-attempt','synthetic-question',${f.material.input_json},${f.material.input_hash},${f.material.analysis_json},'ready','evidence_v2',${stamp},${stamp})`);
    for (const card of f.cards) await tx.run(sql`INSERT INTO sentence_learning_units(id,material_id,sentence_id,source_type,source_id,question_id,ordinal,version,body_json,created_at,updated_at) VALUES(${card.id},${card.materialId},${card.sentenceId},'ielts_practice','synthetic-attempt','synthetic-question',${card.ordinal},${card.version},${JSON.stringify(card)},${stamp},${stamp})`);
    await tx.run(sql`INSERT INTO material_validation_cache(material_id,fingerprint,rule_version,valid,result_json,checked_at) VALUES(${f.material.id},${materialFingerprint(f.material)},${SENTENCE_VALIDATION_VERSION},1,'{}',${stamp})`);
    await tx.run(sql`INSERT INTO sentence_study_progress(sentence_id,first_seen_at,last_seen_at,due_at,fsrs_json,review_count,version,last_rating) VALUES(${f.cards[0].id},${stamp},${stamp},'2026-09-20T00:00:00.000Z','{"fixture":"saved-fsrs"}',2,3,'remembered')`);
    await tx.run(sql`INSERT INTO sentence_study_events(session_id,client_event_id,payload_hash,kind,sentence_id,rating,created_at) VALUES('saved-session','saved-event','saved-hash','rate',${f.cards[0].id},'remembered',${stamp})`);
    const card = f.cards[0], anchor = highlightAnchor(card.english, 7, 15);
    await tx.run(sql`INSERT INTO sentence_highlights(id,sentence_id,language,text_version,text_hash,start_offset,end_offset,quote,prefix,suffix,client_request_id,request_hash,created_at,updated_at) VALUES('saved-mark',${card.id},'en',${card.version},${anchor.text_hash},${anchor.start_offset},${anchor.end_offset},${anchor.quote},${anchor.prefix},${anchor.suffix},'saved-mark-request','saved-mark-hash',${stamp},${stamp})`);
  });
  return {...f, ...db};
}
async function protectedRows(tx: SqlReader) {
  const output: unknown[] = [];
  for (const table of ['speaking_question_attempts', 'practice_materials', 'sentence_study_progress', 'sentence_study_events', 'sentence_highlights']) {
    output.push(await tx.all({sql: `SELECT * FROM ${table} ORDER BY rowid`}));
  }
  return output;
}

describe('independently reviewed sentence teaching', () => {
  it('binds every sentence and text hash without altering source cards', () => {
    const f = fixture(), before = structuredClone(f.cards);
    const result = compileTeachingEdition(f.material, f.cards, f.author, f.review);
    expect(result.attachments).toHaveLength(3);
    expect(result.attachments[0]).toMatchObject({sentenceId: f.cards[0].id, textVersion: f.cards[0].version});
    expect(f.cards).toEqual(before);
  });
  it.each(['candidate', 'context', 'run', 'negative', 'missing-row', 'wrong-source-quote'])('rejects invalid %s review evidence', kind => {
    const f = fixture();
    if (kind === 'candidate') f.author.sentences[0].teaching.overviewZh += '变更';
    if (kind === 'context') f.review.reviewerContext = f.author.authorContext;
    if (kind === 'run') f.review.runId = f.author.runId;
    if (kind === 'negative') f.review.approved = false;
    if (kind === 'missing-row') f.review.sentences.pop();
    if (kind === 'wrong-source-quote') f.review.sentences[0].sourceQuote = 'Not present in this original source.';
    expect(() => compileTeachingEdition(f.material, f.cards, f.author, f.review)).toThrow();
  });
  it.each(['meaningCovered', 'naturalEnglish', 'teachingCorrect', 'examplesCorrect'] as const)('rejects a negative sentence dimension: %s', field => {
    const f = fixture(); f.review.sentences[0][field] = false;
    expect(() => compileTeachingEdition(f.material, f.cards, f.author, f.review)).toThrow();
  });
  it.each(['english-quote', 'chinese-quote', 'missing-meaning', 'source', 'analysis'])('rejects invalid %s even with synthetic positive review', kind => {
    const f = fixture();
    if (kind === 'english-quote') f.author.sentences[0].teaching.parts[0].quoteEn = 'I eat at night.';
    if (kind === 'chinese-quote') f.author.sentences[0].teaching.parts[0].cueZh = '我早上读书。';
    if (kind === 'missing-meaning') f.author.sentences[0].teaching.parts[0].cueZh = '我';
    if (kind === 'source') f.material.input_json += ' ';
    if (kind === 'analysis') f.material.analysis_json += ' ';
    resign(f);
    expect(() => compileTeachingEdition(f.material, f.cards, f.author, f.review)).toThrow();
  });
  it('permits explicit partial approval and preserves the actual negative verdict', () => {
    const f = partialFixture(), result = compileTeachingSentenceRevision(f.material, revision(f));
    expect(result.cards.map(card => card.id)).toEqual([f.cards[0].id, f.cards[2].id]);
    expect(result.attention).toHaveLength(1);
    expect(result.review.approved).toBe(false);
    expect(result.review.sentences[1].approved).toBe(false);
    expect(result.cards[1].contextZh).toBe(f.cards[0].chinese);
    expect(result.cards[1].version).not.toBe(f.cards[2].version);
    expect(result.teaching.attachments).toHaveLength(2);
  });
  it.each(['no-partial-approval', 'no-attention-decision', 'no-author-uncertainty', 'another-negative', 'contradictory-global-approval'])('rejects implicit or contradictory partial approval: %s', kind => {
    const f = partialFixture();
    if (kind === 'no-partial-approval') delete f.review.partialApproval;
    if (kind === 'no-attention-decision') delete f.review.sentences[1].decision;
    if (kind === 'no-author-uncertainty') delete f.author.sentences[1].issue;
    if (kind === 'another-negative') f.review.sentences[0].approved = false;
    if (kind === 'contradictory-global-approval') { f.review.approved = true; delete f.review.partialApproval; }
    resign(f);
    expect(() => compileTeachingSentenceRevision(f.material, revision(f))).toThrow();
  });
});

describe('versioned sentence correction projection', () => {
  it('v2 keeps only exact unique targets and removes their obsolete linked notes', () => {
    const f = correctedFixture(), before = structuredClone(f.cards), result = compileTeachingSentenceRevision(f.material, revision(f));
    expect(result.cards[0].english).toBe('I enjoy reading at night.');
    expect(result.cards[0].id).not.toBe(f.cards[0].id);
    expect(result.cards[0].usages.map(u => u.id)).toEqual(['retained']);
    expect(result.cards[0].notes.map(n => n.id)).toEqual(['retained']);
    expect(result.cards[0].usages[0].text).not.toBe(result.cards[0].english);
    expect(result.cards[1].id).toBe(f.cards[1].id);
    expect(f.cards).toEqual(before);
  });
  it('v2 drops ambiguous repeated target ranges instead of guessing', () => {
    const f = correctedFixture(), item = f.author.sentences[0].issue!;
    item.suggestedEnglish = 'At night, I read at night and rest at night.';
    item.correctedTeaching = teaching(f.cards[0].chinese, item.suggestedEnglish); resign(f);
    const result = compileTeachingSentenceRevision(f.material, revision(f));
    expect(result.cards[0].usages.some(u => u.id === 'retained')).toBe(false);
    expect(result.cards[0].notes.some(n => n.id === 'retained')).toBe(false);
  });
  it('retains replay semantics of v1 without applying its fallback to v2', () => {
    const f = correctedFixture(), old = compileTeachingSentenceRevision(f.material, revision(f, false));
    expect(old.cards[0].usages.find(u => u.id === 'obsolete')?.text).toBe(old.cards[0].english);
    expect(old.cards[0].notes).toEqual(f.cards[0].notes);
    expect(compileTeachingSentenceRevision(f.material, JSON.parse(JSON.stringify(old.draft))).cards).toEqual(old.cards);
    expect(compileTeachingSentenceRevision(f.material, revision(f)).cards[0].usages).toHaveLength(1);
  });
  it('rejects source card drift and edited text hidden behind a display-only version', () => {
    const f = fixture(), raw = revision(f); raw.sourceCards[0].version = 'different-version';
    expect(() => compileTeachingSentenceRevision(f.material, raw)).toThrow();
    const g = fixture(), current = structuredClone(g.cards); current[0].version = 'display-only'; current[0].english = 'Changed meaning.';
    expect(() => compileTeachingEdition(g.material, current, g.author, g.review, {}, g.cards)).toThrow();
  });
});

describe('transactional teaching publication', () => {
  it('teaching-only publication keeps sentence bodies, progress and personal highlights unchanged', async () => {
    const f = await seeded(fixture());
    const before = await f.database.read(protectedRows);
    const bodies = await f.database.read(tx => tx.all(sql`SELECT * FROM sentence_learning_units ORDER BY id`));
    const first = await f.database.write(tx => applyTeachingEdition(tx, f.material, f.cards, f.author, f.review));
    expect((await f.database.write(tx => applyTeachingEdition(tx, f.material, f.cards, f.author, f.review))).id).toBe(first.id);
    expect(await f.database.read(protectedRows)).toEqual(before);
    expect(await f.database.read(tx => tx.all(sql`SELECT * FROM sentence_learning_units ORDER BY id`))).toEqual(bodies);
    const attachments = await f.database.read(tx => readTeachingAttachments(tx, [f.material.id]));
    expect(withTeaching(f.cards[0], attachments)).toMatchObject({id: f.cards[0].id, version: f.cards[0].version, teachingRevision: first.id});
  });
  it('appends v2 after published v1 using its exact active snapshot, preserving old evidence and scores', async () => {
    const f = await seeded(), before = await f.database.read(protectedRows);
    const old = await f.database.write(tx => applyTeachingSentenceRevision(tx, f.material, revision(f, false)));
    const oldRows = await f.database.read(tx => tx.all(sql`SELECT * FROM sentence_material_editions WHERE id=${old.id}`));
    const raw = {...revision(f), replacesEditionId: old.id, expectedActiveHash: sha256Text(JSON.stringify(old.cards))};
    const current = await f.database.write(tx => applyTeachingSentenceRevision(tx, f.material, raw));
    expect(current.id).not.toBe(old.id);
    expect(current.cards[0].usages.map(u => u.id)).toEqual(['retained']);
    expect(await f.database.read(tx => tx.all(sql`SELECT * FROM sentence_material_editions WHERE id=${old.id}`))).toEqual(oldRows);
    expect(await f.database.read(protectedRows)).toEqual(before);
    expect(await f.database.read(tx => tx.all(sql`SELECT * FROM sentence_study_progress WHERE sentence_id=${current.cards[0].id}`))).toEqual([]);
    const teaching1 = await f.database.write(tx => applyTeachingEdition(tx, f.material, old.cards, f.author, f.review, old.mapping, f.cards));
    const teaching2 = await f.database.write(tx => applyTeachingEdition(tx, f.material, current.cards, f.author, f.review, current.mapping, f.cards));
    expect(teaching2.id).not.toBe(teaching1.id);
    expect((await f.database.write(tx => applyTeachingSentenceRevision(tx, f.material, raw))).id).toBe(current.id);
  });
  it.each(['hash', 'edition'])('rejects wrong %s during v1-to-v2 replacement without changing active cards', async field => {
    const f = await seeded(), old = await f.database.write(tx => applyTeachingSentenceRevision(tx, f.material, revision(f, false)));
    const before = await f.database.read(tx => tx.all(sql`SELECT * FROM sentence_learning_units ORDER BY id`));
    const raw = {...revision(f), replacesEditionId: field === 'edition' ? 'not-the-active-edition' : old.id,
      expectedActiveHash: field === 'hash' ? 'not-the-active-hash' : sha256Text(JSON.stringify(old.cards))};
    await expect(f.database.write(tx => applyTeachingSentenceRevision(tx, f.material, raw))).rejects.toMatchObject({code: 'teaching_source_changed'});
    expect(await f.database.read(tx => tx.all(sql`SELECT * FROM sentence_learning_units ORDER BY id`))).toEqual(before);
  });
  it('rejects a superseding publication or drifted active body instead of overwriting it', async () => {
    const f = await seeded(), old = await f.database.write(tx => applyTeachingSentenceRevision(tx, f.material, revision(f, false)));
    const raw = {...revision(f), replacesEditionId: old.id, expectedActiveHash: sha256Text(JSON.stringify(old.cards))};
    await f.database.write(tx => tx.run(sql`INSERT INTO sentence_material_editions(id,material_id,source_hash,analysis_hash,author_json,review_json,cards_json,created_at) VALUES('newer-edition',${f.material.id},${f.author.sourceHash},${f.author.analysisHash},${JSON.stringify(old.draft)},${JSON.stringify(old.review)},${JSON.stringify(old.cards)},'2099-01-01T00:00:00.000Z')`));
    await expect(f.database.write(tx => applyTeachingSentenceRevision(tx, f.material, raw))).rejects.toMatchObject({code: 'teaching_source_changed'});
    await f.database.write(tx => tx.run(sql`UPDATE sentence_learning_units SET body_json='{"newer":"body"}' WHERE id=${old.cards[0].id}`));
    await expect(f.database.write(tx => applyTeachingSentenceRevision(tx, f.material, {...raw, replacesEditionId: 'newer-edition'}))).rejects.toMatchObject({code: 'teaching_source_changed'});
  });
  it('isolates only the explicitly uncertain unit while retaining its historical records', async () => {
    const f = await seeded(partialFixture()), before = await f.database.read(protectedRows);
    const result = await f.database.write(tx => applyTeachingSentenceRevision(tx, f.material, revision(f)));
    expect(result.cards).toHaveLength(2);
    expect(await f.database.read(tx => tx.all<{active: number}>(sql`SELECT active FROM sentence_learning_units WHERE id=${f.cards[1].id}`))).toEqual([{active: 0}]);
    expect(await f.database.read(protectedRows)).toEqual(before);
    const [receipt] = await f.database.read(tx => tx.all<{review_json: string}>(sql`SELECT review_json FROM sentence_material_editions WHERE id=${result.id}`));
    expect(JSON.parse(receipt.review_json)).toMatchObject({approved: false, partialApproval: true});
    const marks = await f.database.read(tx => tx.all<StoredSentenceHighlight>(sql`SELECT * FROM sentence_highlights`));
    expect(projectStoredSentenceHighlights(marks, {sentenceId: f.cards[0].id, textVersion: result.cards[0].version, language: 'en'}, result.cards[0].english).highlights).toHaveLength(1);
  });
  it('refuses publication of a withdrawn teaching material', async () => {
    const f = await seeded(fixture());
    await expect(f.database.write(tx => applyTeachingEdition(tx, {...f.material, status: 'hidden'}, f.cards, f.author, f.review))).rejects.toMatchObject({code: 'material_changed'});
    expect(await f.database.read(tx => tx.all(sql`SELECT * FROM sentence_teaching_editions`))).toEqual([]);
  });
});
