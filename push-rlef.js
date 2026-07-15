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
const { loadRanklandConfig } = require('./rankland-config');
const {
  RANKLAND_CONTEST_FIELDS,
  flattenRanklandContestPayload,
  normalizeRanklandTimeDuration,
} = require('./rankland-contest-http');

/** @typedef {import('./rankland-event-feed.schema').RanklandEventFeedMetadata} RanklandEventFeedMetadata */
/** @typedef {import('./rankland-event-feed.schema').RanklandInitialContestConfig} RanklandInitialContestConfig */
/** @typedef {import('./rankland-event-feed.schema').RanklandFeedEvent} RanklandFeedEvent */

const isDev = process.env.NODE_ENV === 'development';
const producerIdentity = getStableMachineIdentity();
const PRODUCER_ID = `sdutoj:${producerIdentity.machineHash.slice(0, 12)}`;
const PRODUCER_IDENTITY_SUMMARY = producerIdentity.summary;
const AUTO_PUSH_INTERVAL_MS = 200;
const MAX_PUSH_BATCH_SIZE = 1000;
const PUSH_SPEED_LEVELS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, MAX_PUSH_BATCH_SIZE];
const STATUS_PROGRESS_BAR_WIDTHS = [20, 10, 5];
const CONTEST_UPDATE_FIELDS = [
  'name',
  ...RANKLAND_CONTEST_FIELDS,
  'problems',
  'users',
  'markers',
  'series',
  'sorter',
  'contributors',
];

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
  flattenRanklandContestPayload(initialConfig, 'initial config');
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
  const ranklandConfig = flattenRanklandContestPayload(initialConfig, 'initial config');
  const body = { uk };
  for (const field of CONTEST_UPDATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(ranklandConfig, field)) {
      body[field] = ranklandConfig[field];
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
  const ranklandConfig = flattenRanklandContestPayload(initialConfig, 'initial config');
  const body = {};
  const changedFields = [];
  for (const field of CONTEST_UPDATE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(ranklandConfig, field)) {
      continue;
    }
    const desiredField = ranklandConfig[field];
    const existingField = normalizeContestFieldForCompare(field, existingContest[field], desiredField);
    if (!_.isEqual(existingField, desiredField)) {
      body[field] = desiredField;
      changedFields.push(field);
    }
  }
  return { body, changedFields };
}

function normalizeContestFieldForCompare(field, existingField, feedField) {
  if ((field === 'duration' || field === 'frozenDuration') && Array.isArray(existingField)) {
    return normalizeRanklandTimeDuration(existingField, `existing contest.${field}`);
  }
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

function normalizePlaybackSpeed(speed) {
  const normalized = Number(speed);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    return 1;
  }
  for (const level of PUSH_SPEED_LEVELS) {
    if (normalized <= level) {
      return level;
    }
  }
  return MAX_PUSH_BATCH_SIZE;
}

function adjustPlaybackSpeed(speed, direction) {
  const normalizedSpeed = normalizePlaybackSpeed(speed);
  const currentIndex = PUSH_SPEED_LEVELS.indexOf(normalizedSpeed);
  if (direction === 'right') {
    return PUSH_SPEED_LEVELS[Math.min(currentIndex + 1, PUSH_SPEED_LEVELS.length - 1)];
  }
  if (direction === 'left') {
    return PUSH_SPEED_LEVELS[Math.max(currentIndex - 1, 0)];
  }
  return normalizedSpeed;
}

function getNextEventBatch(events, nextIndex, speed) {
  const start = Math.max(0, Number(nextIndex) || 0);
  const count = normalizePlaybackSpeed(speed);
  return events.slice(start, start + count);
}

function fitStatusLine(text, width) {
  const terminalWidth = Math.max(20, Number(width) || 80);
  const safeWidth = Math.max(1, terminalWidth - 1);
  if (text.length > safeWidth) {
    return `${text.slice(0, Math.max(0, safeWidth - 3))}...`;
  }
  return text.padEnd(safeWidth, ' ');
}

function renderProgressBar(sent, total, width) {
  const barWidth = Number.isInteger(Number(width)) && Number(width) > 0 ? Number(width) : 20;
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeSent = Math.max(0, Math.min(Number(sent) || 0, safeTotal));
  const ratio = safeTotal > 0 ? safeSent / safeTotal : 1;
  const filled = Math.round(ratio * barWidth);
  return `${'#'.repeat(filled)}${'-'.repeat(barWidth - filled)}`;
}

function buildStatusLineText({ speed, sent, total, busy, autoEnabled, barWidth }) {
  const progressBar = renderProgressBar(sent, total, barWidth);
  const suffix = ` | ${autoEnabled ? 'AUTO' : 'MANUAL'} | a auto | Enter push | <-/-> speed | q quit`;
  const percent = total > 0 ? Math.floor((sent / total) * 100) : 100;
  return ` speed:${normalizePlaybackSpeed(speed)}x ${sent}/${total} [${progressBar}] ${percent}% ${busy ? 'PUSHING' : 'READY'}${suffix}`;
}

function chooseProgressBarWidth({ speed, sent, total, busy, autoEnabled, terminalWidth }) {
  const safeWidth = Math.max(1, terminalWidth - 1);
  for (const barWidth of STATUS_PROGRESS_BAR_WIDTHS) {
    const line = buildStatusLineText({ speed, sent, total, busy, autoEnabled, barWidth });
    if (line.length <= safeWidth) {
      return barWidth;
    }
  }
  return STATUS_PROGRESS_BAR_WIDTHS[STATUS_PROGRESS_BAR_WIDTHS.length - 1];
}

function renderStatusLine({ speed, sent, total, width, busy, autoEnabled }) {
  const terminalWidth = Math.max(20, Number(width) || 80);
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeSent = Math.max(0, Math.min(Number(sent) || 0, safeTotal));
  const barWidth = chooseProgressBarWidth({
    speed,
    sent: safeSent,
    total: safeTotal,
    busy,
    autoEnabled,
    terminalWidth,
  });
  return fitStatusLine(
    buildStatusLineText({ speed, sent: safeSent, total: safeTotal, busy, autoEnabled, barWidth }),
    terminalWidth,
  );
}

function getTerminalWidth(outputStream) {
  return Math.max(20, Number(outputStream && outputStream.columns) || 80);
}

function createStatusRenderer(outputStream) {
  const stream = outputStream || output;
  return {
    render(state) {
      const line = renderStatusLine({ ...state, width: getTerminalWidth(stream) });
      stream.write(`\r\x1b[2K\x1b[7m${line}\x1b[0m\r`);
    },
    logAbove(message, state) {
      stream.write(`\r\x1b[2K${message}\n`);
      this.render(state);
    },
    finishLine() {
      stream.write('\r\x1b[2K\n');
    },
  };
}

async function appendEvents(req, uk, streamRevision, events) {
  return req.post(
    contestPath(uk, '/events'),
    {
      streamRevision,
      events,
    },
    {
      headers: {
        'x-producer-id': PRODUCER_ID,
      },
    },
  );
}

async function appendEvent(req, uk, streamRevision, event) {
  return appendEvents(req, uk, streamRevision, [event]);
}

function isQuit(line) {
  const value = `${line || ''}`.trim().toLowerCase();
  return value === 'q' || value === 'quit' || value === 'exit';
}

async function appendEventsOnEnter(req, uk, streamRevision, events, options = {}) {
  if (!events.length) {
    console.log('feed has no events; nothing to push');
    return;
  }

  const inputStream = options.input || input;
  const outputStream = options.output || output;
  const renderer = createStatusRenderer(outputStream);
  let currentStreamRevision = streamRevision;
  let nextIndex = 0;
  let speed = 1;
  let autoEnabled = false;
  let busy = false;
  let done = false;
  let stopAfterCurrentBatch = false;
  let autoTimer = null;
  let onKeypress = () => {};
  const canUseRawMode = inputStream && inputStream.isTTY && typeof inputStream.setRawMode === 'function';
  const wasRawMode = canUseRawMode ? !!inputStream.isRaw : false;

  readline.emitKeypressEvents(inputStream);
  if (canUseRawMode) {
    inputStream.setRawMode(true);
  }
  if (typeof inputStream.resume === 'function') {
    inputStream.resume();
  }

  outputStream.write('Controls: Enter push next batch, a toggle auto, Left/Right adjust speed, q quit\n');

  const getStatusState = () => ({
    speed,
    sent: nextIndex,
    total: events.length,
    busy,
    autoEnabled,
  });
  const render = () => {
    renderer.render(getStatusState());
  };

  const cleanup = () => {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
    inputStream.off('keypress', onKeypress);
    if (canUseRawMode) {
      inputStream.setRawMode(wasRawMode);
    }
    if (typeof inputStream.pause === 'function') {
      inputStream.pause();
    }
  };

  const toggleAutoMode = (resolve, reject) => {
    autoEnabled = !autoEnabled;
    if (autoEnabled) {
      autoTimer = setInterval(() => {
        sendNextBatch(resolve, reject);
      }, AUTO_PUSH_INTERVAL_MS);
    } else if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
    render();
  };

  const finish = (message) => {
    if (done) {
      return;
    }
    done = true;
    cleanup();
    renderer.finishLine();
    if (message) {
      outputStream.write(`${message}\n`);
    }
  };

  const rejectWithCleanup = (reject, error) => {
    if (!done) {
      done = true;
      cleanup();
      renderer.finishLine();
    }
    reject(error);
  };

  const sendNextBatch = async (resolve, reject) => {
    if (busy || done) {
      render();
      return;
    }
    if (nextIndex >= events.length) {
      finish('all feed events pushed');
      resolve();
      return;
    }

    const batch = getNextEventBatch(events, nextIndex, speed);
    if (!batch.length) {
      finish('all feed events pushed');
      resolve();
      return;
    }

    busy = true;
    const fromEventId = batch[0].eventId;
    const toEventId = batch[batch.length - 1].eventId;
    try {
      const result = await appendEvents(req, uk, currentStreamRevision, batch);
      if (done) {
        return;
      }
      if (Number.isInteger(result.streamRevision)) {
        currentStreamRevision = result.streamRevision;
      }
      nextIndex += batch.length;
      busy = false;
      renderer.logAbove(`pushed ${fromEventId}-${toEventId}`, getStatusState());
      if (stopAfterCurrentBatch) {
        finish('stopped before sending remaining events');
        resolve();
        return;
      }
      if (nextIndex >= events.length) {
        finish('all feed events pushed');
        resolve();
      }
    } catch (e) {
      busy = false;
      if (done) {
        return;
      }
      rejectWithCleanup(reject, e);
    }
  };

  try {
    render();
    await new Promise((resolve, reject) => {
      onKeypress = (str, key = {}) => {
        if (key.ctrl && key.name === 'c') {
          if (busy) {
            stopAfterCurrentBatch = true;
            renderer.logAbove('will stop after current batch', getStatusState());
            return;
          }
          finish('interrupted by user');
          resolve();
          return;
        }
        if (isQuit(str) || isQuit(key.name)) {
          if (busy) {
            stopAfterCurrentBatch = true;
            renderer.logAbove('will stop after current batch', getStatusState());
            return;
          }
          finish('stopped before sending remaining events');
          resolve();
          return;
        }
        if (key.name === 'right') {
          speed = adjustPlaybackSpeed(speed, 'right');
          render();
          return;
        }
        if (key.name === 'left') {
          speed = adjustPlaybackSpeed(speed, 'left');
          render();
          return;
        }
        if (str === 'a' || key.name === 'a') {
          toggleAutoMode(resolve, reject);
          return;
        }
        if (key.name === 'return' || key.name === 'enter' || str === '\r' || str === '\n') {
          sendNextBatch(resolve, reject);
        }
      };
      inputStream.on('keypress', onKeypress);
    });
  } catch (e) {
    if (!done) {
      cleanup();
      renderer.finishLine();
    }
    throw e;
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
  const rlConf = loadRanklandConfig(isDev);
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
  adjustPlaybackSpeed,
  appendEvent,
  appendEvents,
  appendEventsOnEnter,
  buildContestUpdate,
  buildCreateContestBody,
  createRequestClient,
  getNextEventBatch,
  getStableMachineIdentity,
  isContestNotFoundError,
  normalizeContestFieldForCompare,
  readEventFeed,
  renderStatusLine,
  shouldResetExistingStream,
};
