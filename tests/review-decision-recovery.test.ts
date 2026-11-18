import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventInbox } from '../server/v2/events.js';
import { ReviewDecisions, reviewContentHash } from '../server/v2/review-decisions.js';
import { RunResponse } from '../server/v2/run-response.js';
import { Store } from '../server/store.js';
import { TaskConsent } from '../server/v2/consent.js';

const childScript = `
import {join} from 'node:path';
import {EventInbox} from './server/v2/events.ts';
import {ReviewDecisions} from './server/v2/review-decisions.ts';
import {RunResponse} from './server/v2/run-response.ts';
import {Store} from './server/store.ts';
import {TaskConsent} from './server/v2/consent.ts';
const directory=process.env.RAE_REVIEW_FAULT_DIRECTORY, phase=process.env.RAE_REVIEW_FAULT_PHASE;
const inbox=new EventInbox(join(directory,'events.sqlite')), store=new Store(directory), reviews=new ReviewDecisions(inbox);
const source=inbox.ingestProcessed({id:'raw-message',sourceId:'connector:g',sourceGeneration:'g',externalId:'raw-message',kind:'connector.change',
  actor:'external',operation:'create',caseId:'scene',occurredAt:'2026-11-10T07:47:05.000Z',payload:{provider:'wechat-desktop',content:'Owner asks a question',isSelf:true}});
const event=inbox.ingestProcessed({id:'review-event',sourceId:'connector:g',sourceGeneration:'g',externalId:'review-event',kind:'growth.observation',
  actor:'system',operation:'create',caseId:'scene',occurredAt:'2026-11-10T08:00:00.000Z',payload:{provider:'wechat-desktop',eventIds:[source.id]}});
if(phase==='before_commit') process.exit(71);
const validation={isAllowed:()=>true,ownerDependenciesCurrent:()=>true};
const decision={outcome:'notify',
  evidenceIds:[source.id],anchorEventId:source.id,ownerRelation:{kind:'owner_participation',evidenceId:source.id},whyOwnerNeedsToKnow:'There is a new answer.',
  materialChange:{kind:'answer',fields:{answer:'The configuration has been clarified.'}},message:'The question has a new answer.'};
if(phase==='after_proposal') {
  decision.outcome='propose';
  delete decision.message;
  decision.situation={title:'Configuration review',summary:'The authorized evidence is available.',status:'ready',unknowns:[],missingInputs:[]};
  decision.proposal={title:'Bounded proposal',objective:'Summarize authorized evidence',expectedOutput:'One internal summary'};
}
const record=reviews.commit({reviewEvent:event,runId:'original-run',exposedEventIds:[source.id],ownerDependencies:[],input:decision},validation);
if(phase==='after_commit') process.exit(72);
if(phase==='after_proposal') {
  const consent=new TaskConsent({file:inbox.file,inbox});
  reviews.assertCurrent(record,validation);
  consent.propose({...record.input.proposal,caseId:record.caseId,capabilities:['artifact']},record.reviewEventId);
  process.exit(75);
}
RunResponse.publishReview(store,{id:record.messageId,caseId:record.caseId,runId:record.runId,content:record.input.message,
  contentHash:record.contentHash,createdAt:record.createdAt},()=>reviews.assertCurrent(record,validation));
if(phase==='after_message') process.exit(73);
reviews.delivered(record.id,{messageId:record.messageId,contentHash:record.contentHash});
process.exit(74);
`;

async function hardExit(directory: string, phase: string): Promise<number | null> {
  const child = spawn(process.execPath, ['--import', './scripts/test-network-guard.mjs', '--import', 'tsx', '--input-type=module'], {
    cwd: process.cwd(), windowsHide: true, env: { ...process.env, RAE_REVIEW_FAULT_DIRECTORY: directory, RAE_REVIEW_FAULT_PHASE: phase },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics += chunk; }); child.stderr.on('data', chunk => { diagnostics += chunk; });
  child.stdin.end(childScript);
  return new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => {
      if (code === null || code < 71 || code > 75) reject(new Error(`Fault child failed before the intended gate: ${code}\n${diagnostics}`));
      else resolve(code);
    });
  });
}

test('cold-process fault edges preserve the review journal and publish accepted text once without a model replay', async () => {
  const phases = ['before_commit', 'after_commit', 'after_message', 'after_receipt'];
  for (const [index, phase] of phases.entries()) {
    const directory = await mkdtemp(join(tmpdir(), 'rae-review-cold-'));
    assert.equal(await hardExit(directory, phase), 71 + index);
    const inbox = new EventInbox(join(directory, 'events.sqlite')), store = new Store(directory), reviews = new ReviewDecisions(inbox);
    try {
      const record = reviews.byReviewEvent('review-event');
      if (phase === 'before_commit') {
        assert.equal(record, undefined); assert.equal(reviews.pending().length, 0); assert.equal(store.list('messages').length, 0);
        continue;
      }
      assert.ok(record && record.input.outcome === 'notify');
      assert.equal(reviews.pending().length, phase === 'after_receipt' ? 0 : 1);
      const input = { id: record.messageId!, caseId: record.caseId, runId: record.runId, content: record.input.message,
        contentHash: record.contentHash!, createdAt: record.createdAt };
      const validation = { isAllowed: () => true, ownerDependenciesCurrent: () => true };
      RunResponse.publishReview(store, input, () => reviews.assertCurrent(record, validation));
      reviews.delivered(record.id, { messageId: record.messageId, contentHash: record.contentHash });
      RunResponse.publishReview(store, input, () => { throw new Error('An already published message needs no new model or regenerated body'); });
      reviews.delivered(record.id, { messageId: record.messageId, contentHash: record.contentHash });
      assert.equal(store.list('messages').length, 1); assert.equal(reviews.pending().length, 0);
      assert.equal(store.list('messages')[0].content, 'The question has a new answer.');
    } finally { inbox.close(); store.close(); }
  }
});

test('a proposal presented before a cold exit reconciles the existing consent record without approving or recreating work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-review-proposal-cold-'));
  assert.equal(await hardExit(directory, 'after_proposal'), 75);
  const inbox = new EventInbox(join(directory, 'events.sqlite')), reviews = new ReviewDecisions(inbox), consent = new TaskConsent({ file: inbox.file, inbox });
  try {
    const record = reviews.byReviewEvent('review-event'); assert.ok(record && record.input.outcome === 'propose');
    assert.equal(reviews.pending().length, 1); assert.equal(consent.list().length, 1);
    const spec = { ...record.input.proposal, caseId: record.caseId, capabilities: ['artifact' as const] };
    const original = consent.list()[0], recovered = consent.propose(spec, record.reviewEventId);
    assert.equal(recovered.id, original.id); assert.equal(recovered.state, 'proposed');
    reviews.delivered(record.id, { taskId: recovered.id, proposalHash: reviewContentHash(record.input.proposal) });
    assert.equal(consent.list().length, 1); assert.equal(reviews.pending().length, 0);
    assert.equal(inbox.list().some(event => event.kind === 'task.execute'), false);
  } finally { consent.close(); inbox.close(); }
});

test('notification publication rejects a wrong body hash and a conflicting saved identity without overwriting data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-review-publish-'));
  const store = new Store(directory); let checked = 0;
  try {
    const input = { id: 'notification', caseId: 'scene', runId: 'run', content: 'Original accepted message',
      contentHash: reviewContentHash('Original accepted message'), createdAt: '2026-11-10T08:00:00.000Z' };
    assert.throws(() => RunResponse.publishReview(store, { ...input, contentHash: 'wrong' }, () => { checked++; }), /正文与原决定/);
    assert.equal(store.list('messages').length, 0); assert.equal(checked, 0);
    store.insert('messages', { id: input.id, role: 'assistant', caseId: input.caseId, runId: input.runId, createdAt: input.createdAt,
      content: 'A conflicting historical body', outputState: 'complete' });
    assert.throws(() => RunResponse.publishReview(store, input, () => { checked++; }), /绑定其他内容/);
    assert.equal(store.get('messages', input.id)?.content, 'A conflicting historical body'); assert.equal(checked, 0);
    assert.throws(() => RunResponse.publishReview(store, { ...input, id: 'not-current' }, () => { throw new Error('source revoked at publication gate'); }), /source revoked/);
    assert.equal(store.get('messages', 'not-current'), undefined);
  } finally { store.close(); }
});
