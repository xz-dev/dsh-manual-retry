import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../index.js';
import { DEFAULT_NON_RETRYABLE_PATTERNS, RETRY_HINTS, buildRetryMessage, initialRetryFold, matchesRetryHint, matchesNonRetryable, resolveConfig, retryDecision, retryFold } from '../core.js';

function harness(config) {
  const listeners = new Map();
  let command;
  const states = new Map([['manualRetry', initialRetryFold], ['manualRetryHints', { attempt: 0 }]]);
  const events = [];
  const session = { append(type, data) { events.push({ type, data }); if (type === 'llm/retry') states.set('manualRetryHints', { attempt: data.retry }); } };
  const inbox = { nextTurn: [], nextStep: [] };
  const agent = { id: 'session-1', status: 'idle', inbox, session, followup(message) { inbox.nextTurn.push(message); } };
  const ctx = {
    on(name, fn, prepend) { const list = listeners.get(name) ?? []; prepend ? list.unshift(fn) : list.push(fn); listeners.set(name, list); },
    logger: { info() {} },
    commands: { register(def) { command = def; } },
    sessionProjections: {
      register(def) { states.set(def.key, def.init()); },
      stateOf(_, key) { return states.get(key); },
    },
  };
  apply(ctx, config);
  function record(type, data) {
    const event = { type, data };
    const state = states.get('manualRetry');
    states.set('manualRetry', retryFold(state, event));
  }
  async function failure(failure, downstream = async () => undefined, signal = new AbortController().signal) {
    const middleware = listeners.get('agent/request-error');
    let index = 0;
    function next() { const fn = middleware[index++]; return fn ? fn({ agent, turn: 1, step: 1, provider: 'gateway', failure, signal, retryPolicy: { mode: 'normal' } }, next) : downstream(); }
    return next();
  }
  return { command: (rawInput = '', attachments = []) => command.handler({ rawInput, attachments, agent }), agent, record, events, states, failure };
}

test('failed and aborted turns permit one followup without duplicating human user input', () => {
  for (const reason of [{ kind: 'error', error: { message: 'gateway failed' } }, { kind: 'aborted', reason: { kind: 'user' } }, { kind: 'interrupted' }]) {
    const h = harness();
    h.record('turn/start', { turn: 1 });
    assert.match(h.command().text, /not finished/);
    h.record('turn/end', { turn: 1, reason });
    assert.equal(h.command().kind, 'success');
    assert.equal(h.agent.inbox.nextTurn.length, 1);
    assert.equal(h.agent.inbox.nextTurn[0].source.kind, 'dsh-manual-retry');
    assert.equal(h.command().kind, 'error');
    h.agent.inbox.nextTurn.shift();
    h.record('turn/start', { turn: 2 });
    h.record('user/message', buildRetryMessage('session-1', 1, 'retry', 'Retry turn 1'));
    h.record('turn/end', { turn: 2, reason });
    assert.match(h.command().text, /already had its one manual retry/);
    h.record('turn/start', { turn: 3 });
    h.record('user/message', { source: { kind: 'user' } });
    h.record('turn/end', { turn: 3, reason });
    assert.equal(h.command().kind, 'success');
  }
});

test('Esc before the first step: /retry replays the consumed human request verbatim (live seq 5-8 shape)', () => {
  const h = harness();
  const human = { id: 'h1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Count to 40' }] };
  h.record('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [human] });
  h.record('turn/start', { turn: 1 });
  h.record('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  h.record('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } });
  assert.equal(h.command().kind, 'success');
  const sent = h.agent.inbox.nextTurn[0];
  assert.deepEqual(sent.content, human.content);
  assert.equal(sent.source.kind, 'dsh-manual-retry');
});

test('Esc after the request was committed: /retry uses the continue cue, not a duplicate request', () => {
  const h = harness();
  const human = { id: 'h1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Count to 40' }] };
  h.record('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [human] });
  h.record('turn/start', { turn: 1 });
  h.record('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  h.record('user/message', human);
  h.record('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } });
  assert.equal(h.command().kind, 'success');
  assert.match(h.agent.inbox.nextTurn[0].content[0].text, /previous request failed or was interrupted/);
});

test('canceled (discarded) queued input is not treated as consumed', () => {
  const h = harness();
  h.record('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ id: 'h1', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }] });
  h.record('turn/start', { turn: 1 });
  h.record('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' });
  h.record('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } });
  h.command();
  assert.match(h.agent.inbox.nextTurn[0].content[0].text, /previous request failed/);
});

test('completed, output-limit, and blocked turns, busy agent, queued input, arguments and attachments do not retry', () => {
  const h = harness();
  assert.equal(h.command().kind, 'error');
  for (const reason of [{ kind: 'completed' }, { kind: 'max-tokens' }, { kind: 'blocked' }]) {
    h.record('turn/start', { turn: 1 }); h.record('turn/end', { turn: 1, reason });
    assert.equal(h.command().kind, 'error');
  }
  h.record('turn/start', { turn: 2 }); h.record('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'fail' } } });
  assert.equal(h.command(' extra').kind, 'error');
  assert.equal(h.command('', [{ type: 'image' }]).kind, 'error');
  h.agent.status = 'running'; assert.equal(h.command().kind, 'error'); h.agent.status = 'idle';
  h.agent.inbox.nextStep.push({}); assert.equal(h.command().kind, 'error');
  assert.equal(h.agent.inbox.nextTurn.length, 0);
});

test('case-insensitive literal user patterns veto auto retry while ordinary 429 and 5xx pass through', async () => {
  const h = harness();
  for (const text of DEFAULT_NON_RETRYABLE_PATTERNS) {
    const result = await h.failure({ code: 'RATE_LIMIT', message: `Gateway ${text.toUpperCase()}` }, async () => ({ kind: 'retry' }));
    assert.equal(result, undefined, text);
  }
  for (const [code, message] of [['RATE_LIMIT', '429 rate limit'], ['SERVER', 'HTTP 503']]) {
    assert.deepEqual(await h.failure({ code, message }, async () => ({ kind: 'retry' })), { kind: 'retry' });
  }
  assert.equal(matchesNonRetryable('quotaxexceeded', ['quota.exceeded']), false);
  assert.throws(() => resolveConfig({ nonRetryableErrorPatterns: [2] }), /strings/);
  assert.throws(() => resolveConfig({ maxRetries: -1 }), /non-negative/);
});

test('pi-retry unmatched generic transient hints defer native decisions; quota and context overflow stay terminal', async () => {
  const h = harness({ maxRetries: 1 });
  assert.equal(RETRY_HINTS.length, 13);
  assert.equal(matchesRetryHint({ code: 'PI_AI_ERROR', message: 'unexpected EOF.' }, []), true);
  assert.equal(matchesRetryHint({ code: 'PI_AI_ERROR', message: 'quota exceeded: unexpected EOF.' }, []), false);
  assert.equal(matchesRetryHint({ code: 'PI_AI_ERROR', message: 'Reduce the prompt or route to a model with a larger input limit; unexpected EOF.' }, []), false);
  assert.deepEqual(await h.failure({ code: 'PI_AI_ERROR', message: 'unexpected EOF.' }, async () => ({ kind: 'retry' })), { kind: 'retry' });
  assert.equal(h.events.length, 0);
  const controller = new AbortController(); controller.abort();
  assert.equal(await h.failure({ code: 'PI_AI_ERROR', message: 'unexpected EOF.' }, undefined, controller.signal), undefined);
  assert.equal(h.events.length, 0);
});

test('recognized pi-retry hint schedules durable retry and starts next provider attempt', async () => {
  const h = harness({ maxRetries: 1 });
  assert.deepEqual(await h.failure({ code: 'PI_AI_ERROR', message: 'unexpected EOF.' }), { kind: 'retry' });
  assert.deepEqual(h.events.map(event => event.type), ['llm/retry', 'llm/retry-started']);
  assert.equal(await h.failure({ code: 'PI_AI_ERROR', message: 'unexpected EOF.' }), undefined);
  assert.equal(h.events.length, 2);
});

test('retry hints schedule one bounded attempt, preserve durable event order, and stop on abort', async () => {
  const h = harness({ maxRetries: 1 });
  const failure = { code: 'PI_AI_ERROR', message: 'unexpected EOF.' };
  const controller = new AbortController();
  const pending = h.failure(failure, undefined, controller.signal);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.events[0].type, 'llm/retry');
  assert.equal(h.events[0].data.delayMs, 500);
  controller.abort();
  assert.equal(await pending, undefined);
  assert.equal(h.events.length, 1);
  assert.equal(await h.failure(failure), undefined); // same step budget exhausted
  assert.equal(h.events.length, 1);
});
