import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewProgress } from '../server/v2/review.js';

test('review repetition detects unchanged reads and errors but permits real progress', () => {
  const review = new ReviewProgress();
  const input = { eventId: 'source', offset: 0 };
  review.record('read_event', input, { content: 'version one' });
  review.record('read_event', input, { content: 'version one' });
  assert.equal(review.stopped, false);
  review.record('read_event', input, { content: 'version two' });
  assert.equal(review.stopped, false);
  review.record('read_event', input, { content: 'version two' });
  review.record('save_working_state', { content: 'new understanding' }, { saved: true });
  review.record('read_event', input, { content: 'version two' });
  assert.equal(review.stopped, false);
  review.record('read_event', input, { content: 'version two' });
  review.record('read_event', input, { content: 'version two' });
  assert.equal(review.stalled, true);

  const errors = new ReviewProgress();
  for (let i = 0; i < 3; i++) errors.record('learn_method', { evidence: 'missing' }, 'Evidence unavailable', true);
  assert.equal(errors.stalled, true);
  assert.equal(errors.outcome, undefined);

  const finished = new ReviewProgress();
  finished.finish('source-bound-decision', 'silent');
  assert.equal(finished.stopped, true); assert.equal(finished.outcome, 'complete');
  assert.equal(finished.decisionId, 'source-bound-decision');
  assert.throws(() => finished.finish('different-decision', 'notify'), /其他决定/);

  const investigation = new ReviewProgress();
  for (let i = 0; i < 4; i++) {
    investigation.record('read_event', { eventId: 'first' }, { content: 'first' });
    investigation.record('read_event', { eventId: 'second', offset: i * 100 }, { content: 'fresh ' + i });
  }
  assert.equal(investigation.stopped, false, 'returning to earlier evidence after new findings is allowed');
});
