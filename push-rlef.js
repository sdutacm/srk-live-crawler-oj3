#!/usr/bin/env node

const path = require('path');
const readline = require('readline');
const { stdin: input, stdout: output } = require('process');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs-extra');
const Axios = require('axios');
const _ = require('lodash');
const { Command } = require('commander');
const { EVENT_FEED_VERSION } = require('./rankland-event-feed.schema');

/** @typedef {import('./rankland-event-feed.schema').RanklandEventFeedMetadata} RanklandEventFeedMetadata */
/** @typedef {import('./rankland-event-feed.schema').RanklandInitialContestConfig} RanklandInitialContestConfig */
/** @typedef {import('./rankland-event-feed.schema').RanklandFeedEvent} RanklandFeedEvent */

const isDev = process.env.NODE_ENV === 'development';
const producerIdentity = getStableMachineIdentity();
const PRODUCER_ID = `sdutoj:${producerIdentity.machineHash.slice(0, 12)}`;
const PRODUCER_IDENTITY_SUMMARY = producerIdentity.summary;
const CONTEST_UPDATE_FIELDS = [
  'name',
  'contest',
  'problems',
  'users',
  'markers',
  'series',
  'sorter',
  'contributors',
];

function loadRanklandConfig() {
  const configPath = isDev ? './configs/rl-v2.dev' : './configs/rl-v2.prod';
  try {
    return require(configPath);
  } catch (e) {
    e.message = `Failed to load Rankland config ${configPath}: ${e.message}`;
    throw e;
  }
}

function createRequestClient(rlConf) {
  const req = Axios.create({
    baseURL: rlConf.apiBase,
    timeout: 120 * 1000,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-token': rlConf.authToken || '',
    },
  });

  req.interceptors.response.use(
    (response) => {
      const headerError = createApiErrorFromHeaders(response.headers, response.status);
      if (headerError) {
        throw headerError;
      }
      if (!response.data || typeof response.data !== 'object' || !('success' in response.data)) {
        throw new Error('Invalid response');
      }
      if (!response.data.success) {
        throwApiError(response.data, response.status);
      }
      return response.data.data;
    },
    (error) => {
      if (error.response) {
        const headerError = createApiErrorFromHeaders(error.response.headers, error.response.status);
        if (headerError) {
          throw headerError;
        }
      }
      if (error.response && error.response.data && typeof error.response.data === 'object') {
        throwApiError(error.response.data, error.response.status);
      }
      throw error;
    },
  );

  return req;
}

function throwApiError(data, status) {
  const e = new Error(`API Error: ${data.msg || data.message || 'Unknown error'} ${data.code}`);
  e.status = status;
  e.code = data.code;
  e.msg = data.msg || data.message;
  for (const key of [
    'expectedEventId',
    'receivedEventId',
    'conflictEventId',
    'producerId',
    'resetReason',
    'expectedStreamRevision',
    'receivedStreamRevision',
  ]) {
    if (data[key] !== undefined) {
      e[key] = data[key];
    }
  }
  throw e;
}

function decodeHeaderValue(value) {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}

function parseRlErrorHeaders(headers = {}) {
  const success = headers['x-rl-resp-success'];
  if (success !== 'false') {
    return null;
  }
  let meta = {};
  const rawMeta = decodeHeaderValue(headers['x-rl-resp-meta']);
  if (rawMeta) {
    try {
      meta = JSON.parse(rawMeta);
    } catch (e) {
      meta = {};
    }
  }
  return {
    success: false,
    code: headers['x-rl-resp-code'],
    msg: decodeHeaderValue(headers['x-rl-resp-msg']) || 'Unknown protobuf response error',
    ...meta,
  };
}

function createApiErrorFromHeaders(headers, status) {
  const data = parseRlErrorHeaders(headers);
  if (!data) {
    return null;
  }
  try {
    throwApiError(data, status);
  } catch (e) {
    return e;
  }
  return null;
}

function isContestNotFoundError(e) {
  return e && (e.code === 100001 || e.code === 'CONTEST_NOT_FOUND' || e.status === 404);
}

function isContestExistedError(e) {
  return e && (e.code === 100000 || e.code === 'CONTEST_EXISTED');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function getStableMachineIdentity() {
  const macs = [];
  const interfaces = os.networkInterfaces();
  Object.keys(interfaces)
    .sort()
    .forEach((name) => {
      for (const item of interfaces[name] || []) {
        if (!item || item.internal || !item.mac || item.mac === '00:00:00:00:00:00') {
          continue;
        }
        macs.push(item.mac.toLowerCase());
      }
    });

  const cpus = os.cpus() || [];
  const cpuModel = cpus[0] ? cpus[0].model : 'unknown';
  const identity = {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    macs: Array.from(new Set(macs)).sort(),
    cpuModel,
    cpuCount: cpus.length,
    totalMemoryGbBucket: Math.round(os.totalmem() / 1024 / 1024 / 1024),
  };
  const canonical = JSON.stringify(identity);
  const machineHash = sha256Hex(canonical);
  return {
    identity,
    canonical,
    machineHash,
    summary: {
      hostname: identity.hostname,
      platform: identity.platform,
      arch: identity.arch,
      release: identity.release,
      nicCount: identity.macs.length,
      cpuModelHash: sha256Hex(cpuModel).slice(0, 12),
      cpuCount: identity.cpuCount,
      totalMemoryGbBucket: identity.totalMemoryGbBucket,
      machineHash: machineHash.slice(0, 12),
    },
  };
}

function contestPath(uk, suffix = '') {
  return `/contests/${encodeURIComponent(uk)}${suffix}`;
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
}

function parseJsonLine(line, lineNumber) {
  try {
    const parsed = JSON.parse(line);
    assertObject(parsed, `JSONL line ${lineNumber}`);
    return parsed;
  } catch (e) {
    throw new Error(`Invalid JSONL line ${lineNumber}: ${e.message}`);
  }
}

function normalizeUk(uk) {
  return typeof uk === 'string' ? uk.trim() : '';
}

function validateMetadata(metadata) {
  assertObject(metadata, 'metadata line');
  if (metadata.eventFeedVersion !== EVENT_FEED_VERSION) {
    throw new Error(`metadata.eventFeedVersion must be ${EVENT_FEED_VERSION}`);
  }
  if (metadata.state !== 'complete') {
    throw new Error('metadata.state must be "complete"');
  }
  const uk = normalizeUk(metadata.uk);
  if (!uk) {
    throw new Error('metadata.uk is required because push-rlef only accepts the feed file path');
  }
  if (uk.length < 3 || uk.length > 32) {
    throw new Error('metadata.uk must be 3-32 characters long');
  }
  return uk;
}

function validateInitialConfig(initialConfig) {
  assertObject(initialConfig, 'initial config line');
  if (typeof initialConfig.name !== 'string' || !initialConfig.name.trim()) {
    throw new Error('initial config name must be a non-empty string');
  }
  assertObject(initialConfig.contest, 'initial config contest');
  if (!Array.isArray(initialConfig.problems)) {
    throw new Error('initial config problems must be an array');
  }
  if (!Array.isArray(initialConfig.users)) {
    throw new Error('initial config users must be an array');
  }
  if (initialConfig.markers !== undefined && !Array.isArray(initialConfig.markers)) {
    throw new Error('initial config markers must be an array when present');
  }
  if (initialConfig.series !== undefined && !Array.isArray(initialConfig.series)) {
    throw new Error('initial config series must be an array when present');
  }
}

function validateEvents(events) {
  let previousEventId = 0;
  for (const [index, event] of events.entries()) {
    const label = `event line ${index + 3}`;
    assertObject(event, label);
    if (!Number.isInteger(event.eventId) || event.eventId <= 0) {
      throw new Error(`${label} eventId must be a positive integer`);
    }
    if (event.eventId <= previousEventId) {
      throw new Error(`${label} eventId must be strictly increasing`);
    }
    if (typeof event.type !== 'string' || !event.type) {
      throw new Error(`${label} type must be a non-empty string`);
    }
    previousEventId = event.eventId;
  }
}

async function readEventFeed(eventFeedPath) {
  const resolvedPath = path.resolve(process.cwd(), eventFeedPath);
  const raw = await fs.readFile(resolvedPath, 'utf8');
  const lineItems = raw
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter((item) => item.line.length > 0);

  if (lineItems.length < 2) {
    throw new Error('Rankland event feed JSONL must contain at least metadata and initial config lines');
  }

  /** @type {RanklandEventFeedMetadata} */
  const metadata = parseJsonLine(lineItems[0].line, lineItems[0].lineNumber);
  /** @type {RanklandInitialContestConfig} */
  const initialConfig = parseJsonLine(lineItems[1].line, lineItems[1].lineNumber);
  /** @type {RanklandFeedEvent[]} */
  const events = lineItems.slice(2).map((item) => parseJsonLine(item.line, item.lineNumber));
  const uk = validateMetadata(metadata);
  validateInitialConfig(initialConfig);
  validateEvents(events);

  return {
    path: resolvedPath,
    uk,
    metadata,
    initialConfig,
    events,
  };
}

function buildCreateContestBody(uk, initialConfig) {
  const body = { uk };
  for (const field of CONTEST_UPDATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(initialConfig, field)) {
      body[field] = initialConfig[field];
    }
  }
  if (!Array.isArray(body.markers)) {
    body.markers = [];
  }
  if (!Array.isArray(body.series)) {
    body.series = [];
  }
  return body;
}

function buildContestUpdate(existingContest, initialConfig) {
  const body = {};
  const changedFields = [];
  for (const field of CONTEST_UPDATE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(initialConfig, field)) {
      continue;
    }
    const existingField = normalizeContestFieldForCompare(field, existingContest[field], initialConfig[field]);
    if (!_.isEqual(existingField, initialConfig[field])) {
      body[field] = initialConfig[field];
      changedFields.push(field);
    }
  }
  return { body, changedFields };
}

function normalizeContestFieldForCompare(field, existingField, feedField) {
  if (field !== 'users' || !Array.isArray(existingField) || !Array.isArray(feedField)) {
    return existingField;
  }
  return existingField.map((user, index) => normalizeAdminUserForFeedCompare(user, feedField[index]));
}

function normalizeAdminUserForFeedCompare(existingUser, feedUser) {
  if (!existingUser || typeof existingUser !== 'object' || Array.isArray(existingUser)) {
    return existingUser;
  }
  if (!feedUser || typeof feedUser !== 'object' || Array.isArray(feedUser)) {
    return existingUser;
  }

  const normalizedUser = {};
  for (const key of Object.keys(existingUser)) {
    if (key === 'banned' || key === 'broadcasterToken') {
      continue;
    }
    if (existingUser[key] === null && !Object.prototype.hasOwnProperty.call(feedUser, key)) {
      continue;
    }
    normalizedUser[key] = existingUser[key];
  }
  return normalizedUser;
}

function shouldResetExistingStream(stream) {
  if (!stream || typeof stream !== 'object') {
    return false;
  }
  const streamRevision = Number(stream.streamRevision);
  const lastEventId = Number(stream.lastEventId);
  return streamRevision > 1 || (streamRevision === 1 && lastEventId > 0);
}

async function getContest(req, uk) {
  try {
    return await req.get(contestPath(uk));
  } catch (e) {
    if (isContestNotFoundError(e)) {
      return null;
    }
    throw e;
  }
}

async function createContest(req, uk, initialConfig) {
  const body = buildCreateContestBody(uk, initialConfig);
  try {
    return await req.post('/contests', body);
  } catch (e) {
    if (!isContestExistedError(e)) {
      throw e;
    }
    return null;
  }
}

async function updateContest(req, uk, updateBody) {
  if (!Object.keys(updateBody).length) {
    return null;
  }
  return req.patch(contestPath(uk), updateBody);
}

async function getRequiredStream(req, uk) {
  return req.get(contestPath(uk, '/event-stream'));
}

async function resetEvents(req, uk) {
  await req.post(contestPath(uk, '/events/reset'), {});
}

async function appendEvent(req, uk, streamRevision, event) {
  return req.post(
    contestPath(uk, '/events'),
    {
      streamRevision,
      events: [event],
    },
    {
      headers: {
        'x-producer-id': PRODUCER_ID,
      },
    },
  );
}

function askQuestion(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

function isQuit(line) {
  const value = `${line || ''}`.trim().toLowerCase();
  return value === 'q' || value === 'quit' || value === 'exit';
}

async function appendEventsOnEnter(req, uk, streamRevision, events) {
  if (!events.length) {
    console.log('feed has no events; nothing to push');
    return;
  }

  const rl = readline.createInterface({ input, output });
  let currentStreamRevision = streamRevision;
  try {
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const line = await askQuestion(
        rl,
        `Press Enter to push ${index + 1}/${events.length} eventId=${event.eventId} type=${event.type}; type q then Enter to quit: `,
      );
      if (isQuit(line)) {
        console.log('stopped before sending remaining events');
        return;
      }

      const result = await appendEvent(req, uk, currentStreamRevision, event);
      if (Number.isInteger(result.streamRevision)) {
        currentStreamRevision = result.streamRevision;
      }
      console.log('append result:', JSON.stringify(result));
    }
    console.log('all feed events pushed');
  } finally {
    rl.close();
  }
}

async function prepareContest(req, uk, initialConfig) {
  const existingContest = await getContest(req, uk);
  if (!existingContest) {
    const created = await createContest(req, uk, initialConfig);
    if (created) {
      console.log('created contest:', JSON.stringify(created));
      return;
    }
    console.log('contest already existed during create; checking current fields');
  }

  const currentContest = existingContest || await getContest(req, uk);
  if (!currentContest) {
    throw new Error(`contest ${uk} was not found after create conflict`);
  }
  const { body, changedFields } = buildContestUpdate(currentContest, initialConfig);
  if (!changedFields.length) {
    console.log('contest config is already aligned with feed');
    return;
  }
  console.log('updating changed top-level fields:', changedFields.join(', '));
  await updateContest(req, uk, body);
  console.log('contest config updated');
}

async function prepareStream(req, uk) {
  let stream = await getRequiredStream(req, uk);
  console.log('current stream:', JSON.stringify(stream));
  if (shouldResetExistingStream(stream)) {
    console.log('existing stream has pushed events; resetting events');
    await resetEvents(req, uk);
    stream = await getRequiredStream(req, uk);
    console.log('stream after reset:', JSON.stringify(stream));
  } else {
    console.log('stream is empty; skip reset');
  }
  return stream;
}

async function pushFeed(eventFeedPath) {
  const feed = await readEventFeed(eventFeedPath);
  const rlConf = loadRanklandConfig();
  const req = createRequestClient(rlConf);

  console.log(`Rankland API: ${rlConf.apiBase}`);
  console.log(`feed file: ${feed.path}`);
  console.log(`contest uk: ${feed.uk}`);
  console.log(`producer id: ${PRODUCER_ID}`);
  console.log(`producer identity: ${JSON.stringify(PRODUCER_IDENTITY_SUMMARY)}`);
  console.log(`events loaded: ${feed.events.length}`);

  await prepareContest(req, feed.uk, feed.initialConfig);
  const stream = await prepareStream(req, feed.uk);
  await appendEventsOnEnter(req, feed.uk, stream.streamRevision, feed.events);
}

async function main() {
  const program = new Command();
  program
    .name('push-rlef.js')
    .description('Push a Rankland event feed JSONL to a Rankland contest stream')
    .version('1.0.0')
    .arguments('<eventFeedPath>')
    .action((eventFeedPath) => {
      program.eventFeedPath = eventFeedPath;
    })
    .parse(process.argv);

  if (!program.eventFeedPath) {
    program.outputHelp();
    process.exitCode = 1;
    return;
  }

  await pushFeed(program.eventFeedPath);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  CONTEST_UPDATE_FIELDS,
  PRODUCER_ID,
  PRODUCER_IDENTITY_SUMMARY,
  appendEvent,
  buildContestUpdate,
  buildCreateContestBody,
  createRequestClient,
  getStableMachineIdentity,
  isContestNotFoundError,
  normalizeContestFieldForCompare,
  readEventFeed,
  shouldResetExistingStream,
};
