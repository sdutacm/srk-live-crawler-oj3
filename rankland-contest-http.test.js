const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  buildRanklandContestCreatePayload,
  buildRanklandContestUpdatePayload,
  buildRanklandContestFields,
  flattenRanklandContestPayload,
  normalizeRanklandTimeDuration,
  normalizeRanklandTitle,
} = require('./rankland-contest-http');

test('flattens SRK contest metadata into API v2 fields and excludes SRK-only fields', () => {
  const payload = {
    uk: 'contest-a',
    name: 'Contest A',
    contest: {
      title: 'Contest A',
      startAt: '2026-10-24T10:00:00+08:00',
      duration: [5, 'h'],
      endAt: '2026-10-24T15:00:00+08:00',
    },
    problems: [], users: [], markers: [], series: [],
    version: '0.3.0', type: 'ICPC', rows: [{ rank: 1 }],
    updatedAt: '2026-10-24T12:00:00+08:00', options: {},
  };
  assert.deepEqual(flattenRanklandContestPayload(payload), {
    uk: 'contest-a', name: 'Contest A',
    title: { fallback: 'Contest A' },
    startAt: '2026-10-24T10:00:00+08:00', duration: [18000, 's'],
    problems: [], users: [], markers: [], series: [],
  });
  assert.equal(payload.contest.title, 'Contest A');
});

test('omitted or undefined optional metadata stays omitted for partial updates', () => {
  assert.deepEqual(buildRanklandContestFields({ title: 'New title' }), {
    title: { fallback: 'New title' },
  });
  assert.deepEqual(buildRanklandContestFields({
    frozenDuration: undefined, banner: undefined, refLinks: undefined,
  }), {});
});

test('explicit null clears optional metadata', () => {
  assert.deepEqual(buildRanklandContestFields({
    frozenDuration: null, banner: null, refLinks: null,
  }), { frozenDuration: null, banner: null, refLinks: null });
});

test('normalizes title strings and preserves valid multilingual titles', () => {
  assert.deepEqual(normalizeRanklandTitle('Contest'), { fallback: 'Contest' });
  const title = { fallback: 'Contest', 'zh-CN': '比赛' };
  assert.deepEqual(normalizeRanklandTitle(title), title);
});

test('rejects titles that fail the API v2 i18n contract', () => {
  for (const title of ['', '  ', {}, { 'zh-CN': '比赛' },
    { fallback: ' ' }, { fallback: 'Contest', 'zh-CN': 123 }, null, []]) {
    assert.throws(() => normalizeRanklandTitle(title), /title/);
  }
});

test('accepts every API v2 duration unit with whole-second precision', () => {
  for (const [input, expected] of [
    [[0, 's'], 0], [[0.5, 'min'], 30], [[5, 'h'], 18000],
    [[1, 'd'], 86400], [[0xffffffff, 's'], 0xffffffff],
  ]) {
    assert.deepEqual(normalizeRanklandTimeDuration(input), [expected, 's']);
  }
});

test('rejects unsupported, fractional, negative and overflowing contest durations', () => {
  for (const duration of [[1000, 'ms'], [0.5, 's'], [-1, 's'],
    [Infinity, 's'], [0x100000000, 's'], [50000, 'd'], ['1', 's'], [1], null]) {
    assert.throws(() => normalizeRanklandTimeDuration(duration), /duration/);
  }
});

test('create includes required collections and excludes update-only srkFileID', () => {
  const body = buildRanklandContestCreatePayload({
    uk: 'contest-a', name: 'Contest A', srkFileID: '12345', redirectUK: 'contest-b',
    contest: { title: 'Contest A', startAt: '2026-10-24T10:00:00+08:00', duration: [5, 'h'] },
  });
  assert.deepEqual(body.problems, []);
  assert.deepEqual(body.users, []);
  assert.deepEqual(body.markers, []);
  assert.deepEqual(body.series, []);
  assert.equal(body.redirectUK, 'contest-b');
  assert.equal(body.uk, 'contest-a');
  assert.equal('srkFileID' in body, false);
  assert.equal('contest' in body, false);
});

test('patch omits uk and missing fields, retaining explicit null and empty arrays', () => {
  const body = buildRanklandContestUpdatePayload({
    uk: 'contest-a', contest: { banner: null }, srkFileID: null, redirectUK: null,
    problems: null, markers: [], series: null, sorter: null, users: [],
    contributors: undefined,
  });
  assert.deepEqual(body, {
    banner: null, srkFileID: null, redirectUK: null,
    problems: null, markers: [], series: null, sorter: null, users: [],
  });
});

test('create preserves explicit nullable collections', () => {
  const body = buildRanklandContestCreatePayload({
    uk: 'contest-a', name: 'Contest A',
    contest: { title: 'Contest A', startAt: '2026-10-24T10:00:00+08:00', duration: [5, 'h'] },
    problems: null, users: [], markers: null, series: null, sorter: null,
  });
  for (const field of ['problems', 'markers', 'series', 'sorter']) {
    assert.equal(body[field], null);
  }
});

test('shared replay builders still create valid fields and preserve omitted metadata on patch', () => {
  const { buildCreateContestBody, buildContestUpdate } = require('./push-rlef');
  const initialConfig = {
    name: 'Contest A',
    contest: { title: 'Contest A', startAt: '2026-10-24T10:00:00+08:00', duration: [5, 'h'] },
    problems: [], users: [],
  };
  const created = buildCreateContestBody('contest-a', initialConfig);
  assert.deepEqual(created, buildRanklandContestCreatePayload({ uk: 'contest-a', ...initialConfig }));
  const existing = { ...created, duration: [5, 'h'], banner: 'keep.png', refLinks: [{ title: 'OJ', link: 'https://example.com' }] };
  assert.deepEqual(buildContestUpdate(existing, initialConfig), { body: {}, changedFields: [] });
  const update = buildContestUpdate(existing, { ...initialConfig, contest: { ...initialConfig.contest, banner: null } });
  assert.deepEqual(update, { body: { banner: null }, changedFields: ['banner'] });
});
