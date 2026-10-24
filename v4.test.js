const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const Axios = require('axios');
const { rankland_live_contest_producer: producer } = require('./proto/rankland_live_contest_producer');

const script = fs.readFileSync(path.join(__dirname, 'v4.js'), 'utf8');
const cliStart = script.indexOf('const program = new Command();');
assert.ok(cliStart > 0, 'test harness must exclude CLI parsing and main invocation');
const plain = (value) => JSON.parse(JSON.stringify(value));
const header = (request, name) => Object.entries(request.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

// Execute the real crawler functions with an Axios adapter and in-memory files.
// Config credentials, the MySQL driver, and all network access are isolated.
function createCrawler(responses = [], base = {}, options = {}) {
  const sent = [];
  const files = new Map([['base.json', plain(base)]]);
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop };
  let sleepCount = 0;
  const context = vm.createContext({
    Buffer,
    console,
    process: { env: { NODE_ENV: 'development' } },
    require(name) {
      if (name === './rankland-config') {
        return { loadRanklandConfig: () => ({ apiBase: 'https://rankland.invalid/api/v2', authToken: 'test-token' }) };
      }
      if (name.startsWith('./configs/')) return {};
      if (name === 'mysql2/promise') return { createPool() { throw new Error('Unexpected database connection'); } };
      if (name === './utils/logger') return { logger: { getLogger: () => log }, initLogger: noop };
      if (name === './utils') {
        return {
          numberToAlphabet: (index) => String.fromCharCode(65 + index),
          sleep: async () => {
            sleepCount += 1;
            if (options.onSleep) await options.onSleep(sleepCount);
            if (sleepCount > (options.maxSleeps || 3)) throw new Error('test loop limit');
          },
        };
      }
      if (name === 'fs-extra') {
        return {
          readJSONSync(file) {
            if (!files.has(file)) throw new Error(`Missing fixture: ${file}`);
            return plain(files.get(file));
          },
          writeJSONSync: (file, value) => files.set(file, plain(value)),
          existsSync: (file) => files.has(file),
          ensureDirSync: noop,
        };
      }
      if (name === 'axios') {
        return {
          create(config) {
            const instance = Axios.create({
              ...config,
              headers: { ...config.headers },
              adapter: async (request) => {
                sent.push({ ...request, headers: { ...request.headers }, data: Buffer.isBuffer(request.data) ? Buffer.from(request.data) : request.data });
                assert.ok(responses.length, 'unexpected HTTP request');
                const reply = responses.shift();
                if (reply instanceof Error) throw reply;
                const response = { status: 200, headers: {}, config: request, ...reply };
                if (response.status >= 400) {
                  throw Object.assign(new Error(`HTTP ${response.status}`), { isAxiosError: true, response });
                }
                return response;
              },
            });
            // Axios 0.27 recognizes plain objects only in its own JS realm.
            const hostConfig = (config) => config && { ...config, ...(config.headers && { headers: { ...config.headers } }) };
            const get = instance.get;
            const post = instance.post;
            const patch = instance.patch;
            instance.get = (url, config) => get(url, hostConfig(config));
            instance.post = (url, data, config) => post(url, data, hostConfig(config));
            instance.patch = (url, data, config) => patch(url, data, hostConfig(config));
            return instance;
          },
        };
      }
      return require(name);
    },
  });
  vm.runInContext(script.slice(0, cliStart), context, { filename: 'v4.js' });
  const run = (source) => vm.runInContext(source, context);
  const set = (name, value) => {
    context.fixtureValue = value;
    run(`${name} = fixtureValue`);
    delete context.fixtureValue;
  };
  const startAt = new Date('2026-10-24T00:00:00Z');
  for (const [name, value] of Object.entries({
    log, uk: 'contest/one', competitionId: 123, producerId: 'test-producer', srkBasePath: 'base.json',
    competitionDetail: { title: 'Test contest', startAt },
    contest: { title: 'Test contest', startAt: startAt.toISOString(), duration: [5, 'h'] },
    problems: [{ alias: 'A' }], problemMap: { 10: { alias: 'A' } },
    users: [{ id: '7', name: 'Team', official: true }],
    last: { incEventId: 0, lastCompetitionEventId: 0, streamRevision: 2, skippedSolutionIds: [] },
  })) set(name, value);
  return { run, set, sent, files };
}

const success = (data) => ({ data: { success: true, code: 0, data } });
const failure = (code, status = 200) => ({ status, data: { success: false, code, msg: 'API failure' } });
const ack = (ids, extra = {}) => success({ acceptedEventIds: ids, duplicateEventIds: [], lastEventId: ids.at(-1), expectedNextEventId: ids.at(-1) + 1, streamRevision: 2, ...extra });
const submission = (extra = {}) => ({ event: 'solution:SubmitSolution', solutionId: 42, userId: 7, problemId: 10, competitionEventId: 100, createdAt: new Date('2026-10-24T00:01:00Z'), detail: {}, ...extra });

test('create sends flat v2 fields, defaults required arrays, and drops SRK-only fields', async () => {
  const h = createCrawler([failure(100001, 404), success({ _id: '1' })], {
    version: '0.3.0', type: 'ICPC', rows: [{ score: 1 }], solutions: [], _id: 'old',
    srkFileID: '999', viewCount: 10, unknown: true,
  });
  await h.run('syncContest()');
  assert.equal(h.sent[0].url, '/contests/contest%2Fone');
  assert.equal(h.sent[1].method, 'post');
  assert.equal(h.sent[1].url, '/contests');
  const body = JSON.parse(h.sent[1].data);
  assert.deepEqual(body, {
    uk: 'contest/one', name: 'Test contest', title: { fallback: 'Test contest' },
    startAt: '2026-10-24T00:00:00.000Z', duration: [18000, 's'],
    problems: [{ alias: 'A' }], users: [{ id: '7', name: 'Team', official: true }], markers: [], series: [],
  });
  assert.equal(h.sent[1].headers['x-token'], 'test-token');
});

test('patch omits absent nullable fields and uk, and preserves existing user metadata', async () => {
  const priorUser = { id: '7', name: 'Old', avatar: 'avatar.png', photo: 'photo.png', teamMembers: [{ name: 'Member' }], markers: ['gold'], banned: true, broadcasterToken: 'user-token' };
  const h = createCrawler([success({ users: [priorUser] }), success(null)], { version: '0.3', rows: [], srkFileID: '123' });
  await h.run('syncContest()');
  assert.equal(h.sent[1].method, 'patch');
  assert.equal(h.sent[1].url, '/contests/contest%2Fone');
  const body = JSON.parse(h.sent[1].data);
  for (const field of ['uk', 'contest', 'version', 'rows', 'banner', 'refLinks', 'frozenDuration', 'markers', 'series']) {
    assert.equal(Object.hasOwn(body, field), false, field);
  }
  assert.equal(body.srkFileID, '123');
  assert.deepEqual(body.users, [{ ...priorUser, name: 'Team', official: true }]);
});

test('empty SRK base creates valid required arrays even without problems or users', async () => {
  const h = createCrawler([failure('100001'), success({ _id: '1' })]);
  h.set('problems', []);
  h.set('users', []);
  await h.run('syncContest()');
  const body = JSON.parse(h.sent[1].data);
  for (const field of ['problems', 'users', 'markers', 'series']) assert.deepEqual(body[field], []);
});

test('only the contest-not-found business code permits creation', async () => {
  for (const reply of [failure(-2, 404), failure(-5, 401), { status: 404, data: { message: 'No route' } }]) {
    const h = createCrawler([reply, success({ _id: 'unexpected' })]);
    await assert.rejects(h.run('syncContest()'));
    assert.equal(h.sent.length, 1);
  }
  const h = createCrawler();
  for (const code of [100001, '100001', 'CONTEST_NOT_FOUND']) {
    h.set('contest', { code });
    assert.equal(h.run('isContestNotFoundError(contest)'), true);
  }
});

test('uk and name respect separate v2 Unicode length limits', () => {
  const h = createCrawler();
  assert.equal(h.run("isValidContestUK('x'.repeat(64))"), true);
  assert.equal(h.run("isValidContestUK('x'.repeat(65))"), false);
  assert.equal(h.run("isValidContestUK('😀'.repeat(64))"), true);
  assert.equal(h.run("isValidContestName('x'.repeat(255))"), true);
  assert.equal(h.run("isValidContestName('x'.repeat(256))"), false);
  assert.equal(h.run("isValidContestName('ab')"), false);
  h.set('competitionDetail', { title: 'Long title '.repeat(8) });
  assert.equal(h.run('getContestName()'), 'Long title '.repeat(8).trim());
});

test('event stream request and protobuf append use v2 headers, fields, and acknowledgements', async () => {
  const h = createCrawler([success({ uk: 'contest/one', lastEventId: 0, streamRevision: 2, producerId: null }), ack([1, 2, 3, 4])]);
  await h.run('getContestStreamState()');
  assert.equal(h.sent[0].url, '/contests/contest%2Fone/event-stream');
  h.set('eventBuff', [
    submission(),
    submission({ event: 'solution:JudgeProgress', detail: { current: 2, total: 4 } }),
    submission({ event: 'solution:SolutionResultSettle', detail: { result: 1 } }),
    submission({ event: 'solution:SolutionResultChange', detail: { previousResult: 1, result: 4 } }),
  ]);
  h.set('localLastCompetitionEventId', 103);
  await h.run('pushEvents()');
  const request = h.sent[1];
  assert.equal(request.method, 'post');
  assert.equal(request.url, '/contests/contest%2Fone/events');
  assert.equal(header(request, 'Content-Type'), 'application/protobuf', JSON.stringify(request.headers));
  assert.equal(header(request, 'Accept'), 'application/json');
  assert.equal(request.headers['x-token'], 'test-token');
  assert.equal(request.headers['x-producer-id'], 'test-producer');
  const batch = producer.BatchProducerEvent.toObject(producer.BatchProducerEvent.decode(request.data), { longs: Number, enums: String });
  assert.equal(batch.streamRevision, 2);
  assert.deepEqual(batch.events.map((event) => event.eventId), [1, 2, 3, 4]);
  assert.deepEqual(batch.events[0].newSolutionData, { solutionId: 42, userId: '7', problemAlias: 'A', time: { value: 60000, unit: 'MS' } });
  assert.deepEqual(batch.events[1].solutionOnProgressData, { solutionId: 42, percentageProgress: 50 });
  assert.equal(batch.events[2].solutionOnResultSettleData.result, 'AC');
  assert.equal(batch.events[3].solutionOnResultChangeData.previousResult, 'AC');
  assert.equal(batch.events[3].solutionOnResultChangeData.result, 'WA');
  assert.equal(h.run('last.incEventId'), 4);
  assert.equal(h.run('last.lastCompetitionEventId'), 103);
  assert.equal(h.run('eventBuff.length'), 0);
});

test('uint32 overflow is rejected before any protobuf request or cursor persistence', async () => {
  for (const setup of [
    (h) => h.set('eventBuff', [submission({ solutionId: 4294967296 })]),
    (h) => h.set('localIncEventId', 4294967295),
    (h) => h.run('last.streamRevision = 4294967296'),
  ]) {
    const h = createCrawler([ack([1])]);
    h.set('eventBuff', [submission()]);
    setup(h);
    await assert.rejects(h.run('pushEvents()'), /uint32/);
    assert.equal(h.sent.length, 0);
    assert.equal(h.run('last.incEventId'), 0);
    assert.equal(h.run('eventBuff.length'), 1);
  }
});

test('maximum uint32 solution id survives the wire intact', async () => {
  const h = createCrawler([ack([1])]);
  h.set('eventBuff', [submission({ solutionId: 4294967295 })]);
  await h.run('pushEvents()');
  assert.equal(producer.BatchProducerEvent.decode(h.sent[0].data).events[0].newSolutionData.solutionId, 4294967295);
});

test('retry reuses original protobuf bytes and only advances after an acknowledgement', async () => {
  const timeout = Object.assign(new Error('timeout'), { code: 'ECONNABORTED', isAxiosError: true });
  const h = createCrawler([timeout, ack([1], { acceptedEventIds: [], duplicateEventIds: [1] })]);
  const event = submission();
  h.set('eventBuff', [event]);
  await assert.rejects(h.run('pushEvents()'), /timeout/);
  assert.equal(h.run('last.incEventId'), 0);
  event.userId = 999;
  await h.run('pushEvents()');
  assert.deepEqual(h.sent[0].data, h.sent[1].data);
  assert.equal(h.run('last.incEventId'), 1);
});

test('protobuf error headers normalize numeric codes and decode metadata', async () => {
  const h = createCrawler([{ status: 200, data: '', headers: {
    'x-rl-resp-success': 'false', 'x-rl-resp-code': '100007',
    'x-rl-resp-msg': encodeURIComponent('版本错误'),
    'x-rl-resp-meta': encodeURIComponent(JSON.stringify({ expectedStreamRevision: 3 })),
  } }]);
  await assert.rejects(h.run("req.get('/contests/test')"), (error) => {
    assert.equal(error.code, 100007);
    assert.equal(error.msg, '版本错误');
    assert.equal(error.expectedStreamRevision, 3);
    return true;
  });
});

test('malformed success envelopes and inconsistent append acknowledgements never advance cursors', async () => {
  for (const response of [
    { data: { success: 'true', data: {} } },
    ack([1], { lastEventId: 0 }),
    ack([1], { lastEventId: 4294967296 }),
    ack([1], { streamRevision: 3 }),
    ack([1], { expectedNextEventId: 99 }),
  ]) {
    const h = createCrawler([response]);
    h.set('eventBuff', [submission()]);
    await assert.rejects(h.run('pushEvents()'));
    assert.equal(h.run('last.incEventId'), 0);
    assert.equal(h.run('eventBuff.length'), 1);
  }
});

test('stream state rejects invalid wire values and a reset discards old pending bytes', async () => {
  const timeout = Object.assign(new Error('timeout'), { code: 'ECONNABORTED', isAxiosError: true });
  const h = createCrawler([timeout, ack([1], { streamRevision: 3 })]);
  assert.throws(() => h.run('alignLocalStateWithStream({streamRevision: 4294967296, lastEventId: 0})'), /uint32/);
  assert.throws(() => h.run('alignLocalStateWithStream({streamRevision: 2, lastEventId: -1})'), /uint32/);
  h.set('eventBuff', [submission()]);
  await assert.rejects(h.run('pushEvents()'), /timeout/);
  h.run('alignLocalStateWithStream({streamRevision: 3, lastEventId: 0})');
  assert.equal(h.run('eventBuff.length'), 0);
  h.set('eventBuff', [submission()]);
  await h.run('pushEvents()');
  assert.equal(producer.BatchProducerEvent.decode(h.sent[0].data).streamRevision, 2);
  assert.equal(producer.BatchProducerEvent.decode(h.sent[1].data).streamRevision, 3);
  assert.equal(h.run('last.incEventId'), 1);
});

function prepareMain(h) {
  for (const name of ['init', 'initProducerId', 'grabContest', 'grabProblems', 'grabUsers', 'syncContest', 'grabEvents']) h.set(name, async () => {});
  h.set('getContestStreamState', async () => ({ lastEventId: 0, streamRevision: 2 }));
  h.set('eventBuff', [submission()]);
}

test('main stops on deterministic API errors instead of endlessly retrying', async () => {
  for (const [code, status] of [[100003, 200], [100004, 200], [100005, 200], [100006, 200], [100007, 200], [100001, 404], [-5, 401], [100003, 503]]) {
    const h = createCrawler([failure(code, status)]);
    prepareMain(h);
    await assert.rejects(h.run('main()'), (error) => error.code === code);
    assert.equal(h.sent.length, 1);
    assert.equal(h.run('last.incEventId'), 0);
  }
});

test('main retries network errors and temporary HTTP failures without dropping the pending batch', async () => {
  for (const reply of [Object.assign(new Error('network'), { code: 'ECONNRESET', isAxiosError: true }), failure(-1, 503), failure(-1, 408), failure(-1, 429)]) {
    const h = createCrawler([reply, ack([1])], {}, { maxSleeps: 2 });
    prepareMain(h);
    await assert.rejects(h.run('main()'), /test loop limit/);
    assert.equal(h.sent.length, 2);
    assert.deepEqual(h.sent[0].data, h.sent[1].data);
    assert.equal(h.run('last.incEventId'), 1);
  }
});

test('main retries interrupted response bodies but stops size-limit and local failures', async () => {
  const interrupted = Object.assign(new Error('maxContentLength size of -1 exceeded'), {
    isAxiosError: true, code: 'ERR_BAD_RESPONSE', config: { maxContentLength: -1 }, request: {},
  });
  const retry = createCrawler([interrupted, ack([1])], {}, { maxSleeps: 2 });
  prepareMain(retry);
  await assert.rejects(retry.run('main()'), /test loop limit/);
  assert.equal(retry.sent.length, 2);
  assert.deepEqual(retry.sent[0].data, retry.sent[1].data);
  assert.equal(retry.run('last.incEventId'), 1);

  for (const error of [
    Object.assign(new Error('maxContentLength size of 1024 exceeded'), {
      isAxiosError: true, code: 'ERR_BAD_RESPONSE', config: { maxContentLength: 1024 }, request: {},
    }),
    Object.assign(new Error('invalid response JSON'), {
      isAxiosError: true, code: 'ERR_BAD_RESPONSE', config: { maxContentLength: -1 },
    }),
    new Error('local request failure'),
  ]) {
    const stopped = createCrawler([error]);
    prepareMain(stopped);
    await assert.rejects(stopped.run('main()'), (actual) => actual === error);
    assert.equal(stopped.sent.length, 1);
    assert.equal(stopped.run('last.incEventId'), 0);
  }
});
