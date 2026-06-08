const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const crypto = require('crypto');
const Axios = require('axios');
const dayjs = require('dayjs');
const _ = require('lodash');
const { Command } = require('commander');
const { logger, initLogger } = require('./utils/logger');
const { numberToAlphabet, sleep } = require('./utils');
const {
  rankland_live_contest_producer,
  rankland_live_contest_common,
} = require('./proto/rankland_live_contest_producer');

const isDev = process.env.NODE_ENV === 'development';

const MAX_MYSQL_POOL_CONNECTION = 2;
const GRAB_LIMIT = 1;
const GRAB_INTERVAL = 10000;
const DATA_DIR = './data_v4';

let log;
let dbConf = {};
let rlConf = {};
if (isDev) {
  dbConf = require('./configs/oj-db.dev');
  rlConf = require('./configs/rl-v2.dev');
} else {
  dbConf = require('./configs/oj-db.prod');
  rlConf = require('./configs/rl-v2.prod');
}

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

let conn;

async function query(sql, params) {
  const SQL = conn.format(sql, params);
  isDev && log.info('[sql.start]', SQL);
  const _start = Date.now();
  const [rows] = await conn.query(SQL);
  isDev && log.info(`[sql.done]  ${Date.now() - _start}ms`);
  return rows;
}

async function init() {
  if (!conn) {
    conn = mysql.createPool({
      ...dbConf,
      waitForConnections: true,
      connectionLimit: MAX_MYSQL_POOL_CONNECTION,
      queueLimit: 0,
    });
  }
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

// logic

let uk;
let competitionId;
let producerId;
let producerIdentitySummary;
let last = createDefaultLastState();
let localLastCompetitionEventId = 0;
let localIncEventId = 0;
let competitionDetail;
let competitionSettings;
let contest;
let problems = [];
let users = [];
let problemMap = {};
let userMap = {};
let userIdFilter = null;
let userIdFilterConfigPath;
let usersMergeDataConfigPath;
let srkBasePath;
let eventBuff = [];
let skippedSolutionIds = new Set();
let verbose = false;

const ESolutionResult = {
  WT: 0,
  JG: 12,
  AC: 1,
  TLE: 2,
  MLE: 3,
  WA: 4,
  RTE: 5,
  OLE: 6,
  CE: 7,
  PE: 8,
  SE: 11,

  RPD: -1,
  CNL: -2,
};

const oj2SrkResultMap = {
  [ESolutionResult.AC]: 'AC',
  [ESolutionResult.TLE]: 'TLE',
  [ESolutionResult.MLE]: 'MLE',
  [ESolutionResult.WA]: 'WA',
  [ESolutionResult.RTE]: 'RTE',
  [ESolutionResult.OLE]: 'OLE',
  [ESolutionResult.CE]: 'CE',
  [ESolutionResult.PE]: 'PE',
  [ESolutionResult.SE]: 'UKE',
};

const computedResultFallbackMap = {
  FB: 'AC',
  FZ: 'UKE',
};

const CompetitionEvent = {
  SubmitSolution: 'solution:SubmitSolution',
  RejudgeSolution: 'solution:RejudgeSolution',
  JudgeStart: 'solution:JudgeStart',
  JudgeProgress: 'solution:JudgeProgress',
  JudgeFinish: 'solution:JudgeFinish',
  JudgeCancel: 'solution:JudgeCancel',
  SolutionResultSettle: 'solution:SolutionResultSettle',
  SolutionResultChange: 'solution:SolutionResultChange',
};

function createDefaultLastState() {
  return {
    incEventId: 0,
    lastCompetitionEventId: 0,
    streamRevision: 0,
    skippedSolutionIds: [],
  };
}

function normalizeLastState(raw) {
  const rawSkippedSolutionIds = Array.isArray(raw && raw.skippedSolutionIds)
    ? raw.skippedSolutionIds
    : [];
  const skippedSolutionIds = Array.from(
    new Set(rawSkippedSolutionIds.map(normalizePositiveInteger).filter((id) => id !== null)),
  ).sort((a, b) => a - b);
  return {
    ...createDefaultLastState(),
    ...(raw || {}),
    incEventId: Number(raw && raw.incEventId) || 0,
    lastCompetitionEventId: Number(raw && raw.lastCompetitionEventId) || 0,
    streamRevision: Number(raw && raw.streamRevision) || 0,
    skippedSolutionIds,
  };
}

function getStatePath() {
  return path.join(DATA_DIR, `${competitionId}_${uk}.json`);
}

function syncLast() {
  fs.ensureDirSync(DATA_DIR);
  last.skippedSolutionIds = Array.from(skippedSolutionIds).sort((a, b) => a - b);
  fs.writeJSONSync(getStatePath(), last, { spaces: 2 });
}

function normalizePositiveInteger(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
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

function initProducerId() {
  const machineIdentity = getStableMachineIdentity();
  producerIdentitySummary = machineIdentity.summary;
  producerId = `sdutoj:${machineIdentity.machineHash.slice(0, 12)}`;
  log.info('initialized producer identity', { producerId, machineIdentity: machineIdentity.identity });
}

function getTimeDurationMS(time) {
  if (typeof time === 'number' || typeof time === 'string') {
    time = new Date(time);
  }
  return time.getTime() - competitionDetail.startAt.getTime();
}

function getEventTimeDurationMS(time, item) {
  const duration = getTimeDurationMS(time);
  if (Number.isFinite(duration) && duration >= 0) {
    return duration;
  }
  log.warn('clamped invalid event time to contest start', {
    uk,
    solutionId: item.solutionId,
    competitionEventId: item.competitionEventId,
    event: item.event,
    durationMS: duration,
  });
  return 0;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getPercentageProgress(detail, item) {
  const current = Number(detail && detail.current);
  const total = Number(detail && detail.total);
  const safeCurrent = Number.isFinite(current) ? current : 0;
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 1;
  const rawPercentage = Math.floor((safeCurrent / safeTotal) * 100);
  const percentageProgress = clampNumber(rawPercentage, 0, 100);
  if (percentageProgress !== rawPercentage) {
    log.warn('clamped invalid progress percentage', {
      uk,
      solutionId: item.solutionId,
      competitionEventId: item.competitionEventId,
      event: item.event,
      current: detail && detail.current,
      total: detail && detail.total,
      rawPercentage,
      percentageProgress,
    });
  }
  return percentageProgress;
}

function getRawResultValue(ojResult, item, field) {
  const resultName = oj2SrkResultMap[ojResult] || 'UKE';
  const fallbackName = computedResultFallbackMap[resultName];
  const rawResultName = fallbackName || resultName;
  if (fallbackName) {
    log.warn('converted computed result to raw-compatible result', {
      uk,
      solutionId: item.solutionId,
      competitionEventId: item.competitionEventId,
      event: item.event,
      field,
      resultName,
      rawResultName,
    });
  }
  return rankland_live_contest_common.Result[rawResultName] ?? rankland_live_contest_common.Result.UKE;
}

function getProperTimeDuration(durationMS) {
  if (durationMS >= 3600 * 1000 && durationMS % (3600 * 1000) === 0) {
    return [durationMS / (3600 * 1000), 'h'];
  }
  if (durationMS >= 60 * 1000 && durationMS % (60 * 1000) === 0) {
    return [durationMS / (60 * 1000), 'min'];
  }
  if (durationMS >= 1000 && durationMS % 1000 === 0) {
    return [durationMS / 1000, 's'];
  }
  return [durationMS, 'ms'];
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isValidContestName(value) {
  const text = normalizeText(value);
  return text.length >= 3 && text.length <= 32;
}

function getContestTitle() {
  const title = normalizeText(competitionDetail.title);
  if (title) {
    return title;
  }
  const fallbackTitle = normalizeText(uk) || `contest-${competitionId}`;
  log.warn('contest title is empty, fallback to generated title', {
    title: competitionDetail.title,
    uk,
    fallbackTitle,
  });
  return fallbackTitle;
}

function getContestName() {
  const title = normalizeText(competitionDetail.title);
  if (isValidContestName(title)) {
    return title;
  }
  if (isValidContestName(uk)) {
    log.warn('contest title is not a valid RL v2 name, fallback to uk', {
      title: competitionDetail.title,
      uk,
    });
    return uk;
  }
  const fallbackName = `contest-${competitionId}`.slice(0, 32);
  log.warn('contest title and uk are not valid RL v2 names, fallback to generated name', {
    title: competitionDetail.title,
    uk,
    fallbackName,
  });
  return fallbackName;
}

function mergeReplacingArrays(...sources) {
  return _.mergeWith({}, ...sources.filter(Boolean), (objValue, srcValue) => {
    if (Array.isArray(srcValue)) {
      return srcValue;
    }
    return undefined;
  });
}

const PRESERVED_EXISTING_USER_FIELDS = [
  'avatar',
  'photo',
  'teamMembers',
  'markers',
  'banned',
  'broadcasterToken',
];

function pickPreservedExistingUserFields(user) {
  if (!user) {
    return {};
  }
  return PRESERVED_EXISTING_USER_FIELDS.reduce((result, field) => {
    if (user[field] !== undefined) {
      result[field] = user[field];
    }
    return result;
  }, {});
}

function buildMergedUsers(usersExtra, existedUsers = []) {
  const extraById = new Map((usersExtra || []).map((user) => [String(user.id), user]));
  const existedById = new Map((existedUsers || []).map((user) => [String(user.id), user]));
  return users.map((user) =>
    mergeReplacingArrays(
      pickPreservedExistingUserFields(existedById.get(user.id)),
      user,
      extraById.get(user.id),
    ),
  );
}

async function grabContest() {
  const detailRes = await query(`SELECT * FROM competition WHERE competition_id=? LIMIT 1`, [
    competitionId,
  ]);
  const settingsRes = await query(
    `SELECT * FROM competition_setting WHERE competition_id=? LIMIT 1`,
    [competitionId],
  );
  if (!detailRes.length || !settingsRes.length) {
    throw new Error('competition not found');
  }
  competitionDetail = {
    competitionId: +detailRes[0].competition_id,
    title: detailRes[0].title,
    startAt: detailRes[0].start_at,
    endAt: detailRes[0].end_at,
    isTeam: detailRes[0].is_team === 1,
    rule: detailRes[0].rule,
    spConfig: JSON.parse(detailRes[0].sp_config || '{}'),
  };
  competitionSettings = {
    frozenLength: settingsRes[0].frozen_length || 0,
  };
  const contestTitle = getContestTitle();
  contest = {
    title: contestTitle,
    startAt: dayjs(competitionDetail.startAt).format('YYYY-MM-DDTHH:mm:ssZ'),
    duration: getProperTimeDuration(getTimeDurationMS(competitionDetail.endAt)),
    frozenDuration: getProperTimeDuration(competitionSettings.frozenLength * 1000),
  };
  log.info('grabbed contest:', contest);
}

async function grabProblems() {
  const res = await query(
    `SELECT * FROM competition_problem WHERE competition_id=? ORDER BY \`index\` ASC`,
    [competitionId],
  );
  const rows = [];
  const map = {};
  res.forEach((item) => {
    const problem = JSON.parse(
      JSON.stringify({
        alias: item.alias || numberToAlphabet(+item.index),
        style: item.balloon_color
          ? {
              backgroundColor: item.balloon_color,
            }
          : undefined,
      }),
    );
    rows.push(problem);
    map[item.problem_id] = problem;
  });
  problems = rows;
  problemMap = map;
  log.info('grabbed problems:', problems.length);
}

async function grabUsers() {
  const res = await query(
    `SELECT * FROM competition_user WHERE competition_id=? AND role=2 AND banned=false AND status IN (1, 5, 6) ORDER BY created_at ASC`,
    [competitionId],
  );
  const parse = (str, fallback) => {
    try {
      return JSON.parse(str);
    } catch (e) {
      return fallback();
    }
  };
  const rows = [];
  const map = {};
  res.forEach((item) => {
    const id = `${item.user_id}`;
    if (userIdFilter && !userIdFilter.includes(id)) {
      return;
    }
    const info = parse(item.info, () => ({}));
    const members = Array.isArray(info.members) ? info.members : [];
    const organization = info.subname
      ? info.subname
      : competitionDetail.isTeam
      ? members.map((m) => `${m.realName}`).join(' / ')
      : `${info.class || ''} ${info.realName || ''}`.trim();
    const fieldShortName = item.field_short_name || item.fieldShortName;
    const seatNo = item.seat_no || item.seatNo;
    const user = JSON.parse(
      JSON.stringify({
        id,
        name: info.nickname || id,
        official: !(item.unofficial_participation === true || item.unofficial_participation === 1),
        organization: organization || undefined,
        location:
          fieldShortName && seatNo !== undefined && seatNo !== null && `${seatNo}` !== ''
            ? `${fieldShortName}-${seatNo}`
            : undefined,
      }),
    );
    rows.push(user);
    map[id] = user;
  });
  users = rows;
  userMap = map;
  log.info('grabbed users:', users.length);
}

async function syncContest() {
  const srkBase = fs.readJSONSync(srkBasePath);
  let usersExtra = [];
  if (usersMergeDataConfigPath) {
    try {
      usersExtra = fs.readJSONSync(usersMergeDataConfigPath) || [];
      log.info('using users merge data from:', usersMergeDataConfigPath);
    } catch (e) {
      log.warn('failed to read users merge data config:', e.message);
    }
  } else if (fs.existsSync(path.join('extra', `${competitionId}_members.json`))) {
    log.info('using extra users data from:', path.join('extra', `${competitionId}_members.json`));
    usersExtra = fs.readJSONSync(path.join('extra', `${competitionId}_members.json`), { throws: false }) || [];
  }

  const encodedUk = encodeURIComponent(uk);
  let existed;
  try {
    existed = await req.get(`/contests/${encodedUk}`);
  } catch (e) {
    if (isContestNotFoundError(e)) {
      existed = null;
    } else {
      throw e;
    }
  }

  const mergedUsers = buildMergedUsers(usersExtra, existed && existed.users);
  const srk = mergeReplacingArrays(srkBase, {
    contest,
    problems,
    users: mergedUsers,
  });
  const data = {
    ...srk,
    uk,
    name: getContestName(),
  };

  if (existed) {
    const { uk: _ignoredUk, ...updateData } = data;
    await req.patch(`/contests/${encodedUk}`, updateData);
    log.info('updated contest', { uk, users: mergedUsers.length, problems: problems.length });
  } else {
    await req.post('/contests', data);
    log.info('created contest', { uk, users: mergedUsers.length, problems: problems.length });
  }
}

async function getContestStreamState() {
  const stream = await req.get(`/contests/${encodeURIComponent(uk)}/event-stream`);
  log.info('contest stream state', {
    uk,
    producerId,
    serverProducerId: stream.producerId || null,
    lastEventId: stream.lastEventId,
    streamRevision: stream.streamRevision,
  });
  return stream;
}

function alignLocalStateWithStream(stream) {
  const serverStreamRevision = Number(stream.streamRevision) || 0;
  const serverLastEventId = Number(stream.lastEventId) || 0;
  if (!serverStreamRevision) {
    throw new Error('invalid contest streamRevision from rankland-web');
  }

  if (!last.streamRevision) {
    if (serverLastEventId > 0 && last.incEventId !== serverLastEventId) {
      throw new Error(
        `local streamRevision is missing and local event cursor cannot be aligned for ${uk}: localIncEventId=${last.incEventId}, serverLastEventId=${serverLastEventId}. Manual intervention is required.`,
      );
    }
    last.streamRevision = serverStreamRevision;
    log.info('initialized local streamRevision from server', {
      uk,
      producerId,
      streamRevision: last.streamRevision,
      localIncEventId: last.incEventId,
      serverLastEventId,
    });
    syncLast();
    return;
  }

  if (last.streamRevision === serverStreamRevision) {
    return;
  }

  if (serverLastEventId === 0) {
    log.warn('server event stream was reset, resetting local cursors', {
      uk,
      producerId,
      previousLocalStreamRevision: last.streamRevision,
      serverStreamRevision,
    });
    eventBuff = [];
    last = {
      ...createDefaultLastState(),
      streamRevision: serverStreamRevision,
    };
    skippedSolutionIds = new Set();
    localLastCompetitionEventId = 0;
    localIncEventId = 0;
    syncLast();
    return;
  }

  throw new Error(
    `stream revision mismatch for ${uk}: local=${last.streamRevision}, server=${serverStreamRevision}, serverLastEventId=${serverLastEventId}. Manual intervention is required.`,
  );
}

function isContestNotFoundError(e) {
  return e && (e.code === 100001 || e.code === 'CONTEST_NOT_FOUND' || e.status === 404);
}

async function grabEvents() {
  log.info('grab competition events after:', localLastCompetitionEventId);
  const res = await query(
    `SELECT competition_event_id AS competitionEventId, event, solution_id AS solutionId, detail, user_id AS userId, problem_id AS problemId, created_at AS createdAt FROM competition_event WHERE competition_event_id>? AND competition_id=? AND event IN (?) ORDER BY competition_event_id ASC LIMIT ?`,
    [
      localLastCompetitionEventId,
      competitionId,
      [
        CompetitionEvent.SubmitSolution,
        CompetitionEvent.JudgeProgress,
        CompetitionEvent.SolutionResultSettle,
        CompetitionEvent.SolutionResultChange,
      ],
      GRAB_LIMIT,
    ],
  );
  for (let item of res) {
    try {
      item.detail = JSON.parse(item.detail);
    } catch (e) {
      item.detail = {};
    }
    if (item.event === CompetitionEvent.SubmitSolution) {
      item.createdAt = item.detail.time ? new Date(item.detail.time) : item.createdAt;
    }
    eventBuff.push(item);
  }

  if (!res.length) {
    return;
  }

  log.info('grabbed events:', res.length);
  localLastCompetitionEventId = res[res.length - 1].competitionEventId;
}

function markSkippedSolution(item, reason) {
  const solutionId = normalizePositiveInteger(item.solutionId);
  if (solutionId) {
    skippedSolutionIds.add(solutionId);
  }
  log.warn('skip solution event', {
    uk,
    solutionId: item.solutionId,
    competitionEventId: item.competitionEventId,
    event: item.event,
    reason,
  });
}

function shouldSkipChildEvent(item) {
  const solutionId = normalizePositiveInteger(item.solutionId);
  if (!solutionId) {
    log.warn('skip child event with invalid solution id', {
      uk,
      solutionId: item.solutionId,
      competitionEventId: item.competitionEventId,
      event: item.event,
    });
    return true;
  }
  if (solutionId && skippedSolutionIds.has(solutionId)) {
    log.warn('skip child event for skipped solution', {
      uk,
      solutionId,
      competitionEventId: item.competitionEventId,
      event: item.event,
    });
    return true;
  }
  return false;
}

function createProducerEvent(item) {
  switch (item.event) {
    case CompetitionEvent.SubmitSolution: {
      if (!normalizePositiveInteger(item.solutionId)) {
        markSkippedSolution(item, 'invalid solution id');
        return null;
      }
      if (!problemMap[item.problemId]) {
        markSkippedSolution(item, `unknown problem ${item.problemId}`);
        return null;
      }
      return {
        type: rankland_live_contest_common.EventType.NEW_SOLUTION,
        newSolutionData: {
          solutionId: item.solutionId,
          userId: `${item.userId}`,
          problemAlias: problemMap[item.problemId].alias,
          time: {
            value: getEventTimeDurationMS(item.createdAt, item),
            unit: rankland_live_contest_common.TimeUnit.MS,
          },
        },
      };
    }
    case CompetitionEvent.JudgeProgress: {
      if (shouldSkipChildEvent(item)) {
        return null;
      }
      return {
        type: rankland_live_contest_common.EventType.SOLUTION_ON_PROGRESS,
        solutionOnProgressData: {
          solutionId: item.solutionId,
          percentageProgress: getPercentageProgress(item.detail, item),
        },
      };
    }
    case CompetitionEvent.SolutionResultSettle: {
      if (shouldSkipChildEvent(item)) {
        return null;
      }
      return {
        type: rankland_live_contest_common.EventType.SOLUTION_ON_RESULT_SETTLE,
        solutionOnResultSettleData: {
          solutionId: item.solutionId,
          result: getRawResultValue(item.detail.result, item, 'result'),
          time: {
            value: getEventTimeDurationMS(item.createdAt, item),
            unit: rankland_live_contest_common.TimeUnit.MS,
          },
        },
      };
    }
    case CompetitionEvent.SolutionResultChange: {
      if (shouldSkipChildEvent(item)) {
        return null;
      }
      return {
        type: rankland_live_contest_common.EventType.SOLUTION_ON_RESULT_CHANGE,
        solutionOnResultChangeData: {
          solutionId: item.solutionId,
          previousResult: getRawResultValue(item.detail.previousResult, item, 'previousResult'),
          result: getRawResultValue(item.detail.result, item, 'result'),
          time: {
            value: getEventTimeDurationMS(item.createdAt, item),
            unit: rankland_live_contest_common.TimeUnit.MS,
          },
        },
      };
    }
    default:
      return null;
  }
}

function buildBatchEvents() {
  const events = [];
  let skipped = 0;
  for (const item of eventBuff) {
    const event = createProducerEvent(item);
    if (!event) {
      skipped += 1;
      continue;
    }
    if (!item._eventId) {
      item._eventId = ++localIncEventId;
    }
    events.push({
      eventId: item._eventId,
      ...event,
    });
  }
  return { events, skipped };
}

function getDebugAppendBody(events) {
  const batch = rankland_live_contest_producer.BatchProducerEvent.fromObject({
    streamRevision: last.streamRevision,
    events,
  });
  return rankland_live_contest_producer.BatchProducerEvent.toObject(batch, {
    arrays: true,
    enums: String,
    longs: String,
  });
}

function logAppendRequestDebug(pathname, headers, payload, events) {
  if (!verbose) {
    return;
  }
  log.info(
    'append RL events request detail:\n' +
      JSON.stringify(
        {
          method: 'POST',
          baseURL: req.defaults.baseURL,
          path: pathname,
          headers: {
            ...headers,
            'x-token': rlConf.authToken ? '<configured>' : '<empty>',
          },
          bodyBytes: payload.length,
          body: getDebugAppendBody(events),
        },
        null,
        2,
      ),
  );
}

async function pushEvents() {
  if (!eventBuff.length) {
    return;
  }

  const { events: batchData, skipped } = buildBatchEvents();
  if (!batchData.length) {
    log.info('no encodable RL events, syncing local cursor', {
      uk,
      producerId,
      skipped,
      lastCompetitionEventId: localLastCompetitionEventId,
      incEventId: localIncEventId,
    });
    eventBuff = [];
    last.incEventId = localIncEventId;
    last.lastCompetitionEventId = localLastCompetitionEventId;
    syncLast();
    return;
  }

  const eventIdRange = {
    from: batchData[0].eventId,
    to: batchData[batchData.length - 1].eventId,
  };
  log.info('append RL events start', {
    uk,
    producerId,
    streamRevision: last.streamRevision,
    count: batchData.length,
    skipped,
    eventIdRange,
  });

  const payload = Buffer.from(
    rankland_live_contest_producer.BatchProducerEvent.encode({
      streamRevision: last.streamRevision,
      events: batchData,
    }).finish(),
  );
  const appendPath = `/contests/${encodeURIComponent(uk)}/events`;
  const appendHeaders = {
    Accept: 'application/json',
    'Content-Type': 'application/protobuf',
    'x-producer-id': producerId,
  };
  logAppendRequestDebug(appendPath, appendHeaders, payload, batchData);

  try {
    const resp = await req.post(appendPath, payload, {
      headers: appendHeaders,
      transformRequest: [(data) => data],
    });
    log.info('append RL events done', {
      uk,
      producerId,
      count: batchData.length,
      eventIdRange,
      acceptedEventIds: resp.acceptedEventIds,
      duplicateEventIds: resp.duplicateEventIds,
      lastEventId: resp.lastEventId,
      expectedNextEventId: resp.expectedNextEventId,
      streamRevision: resp.streamRevision,
    });
    eventBuff = [];
    last.incEventId = resp.lastEventId;
    localIncEventId = resp.lastEventId;
    last.lastCompetitionEventId = localLastCompetitionEventId;
    last.streamRevision = resp.streamRevision || last.streamRevision;
    syncLast();
  } catch (e) {
    log.error('append RL events failed', {
      uk,
      producerId,
      streamRevision: last.streamRevision,
      count: batchData.length,
      eventIdRange,
      status: e.status,
      code: e.code,
      msg: e.msg || e.message,
      expectedEventId: e.expectedEventId,
      receivedEventId: e.receivedEventId,
      conflictEventId: e.conflictEventId,
      expectedStreamRevision: e.expectedStreamRevision,
      receivedStreamRevision: e.receivedStreamRevision,
      lockedProducerId: e.producerId,
    });
    throw e;
  }
}

async function main() {
  initLogger(uk);
  log = logger.getLogger(isDev ? 'dev' : 'prod');
  initProducerId();
  await init();

  log.info('start', {
    uk,
    competitionId,
    producerId,
    producerIdentitySummary,
    verbose,
    userIdFilterConfigPath,
    usersMergeDataConfigPath,
  });
  if (userIdFilterConfigPath) {
    try {
      userIdFilter = fs.readJSONSync(userIdFilterConfigPath) || null;
      log.info('using id filter', userIdFilter);
    } catch (e) {
      log.warn('failed to read userIdFilterConfigPath:', e.message);
      userIdFilter = null;
    }
  } else {
    log.info('no id filter');
  }

  await grabContest();
  await grabProblems();
  await grabUsers();
  await syncContest();

  try {
    last = normalizeLastState(fs.readJSONSync(getStatePath()));
  } catch (e) {
    log.info('no last data');
    last = createDefaultLastState();
  }
  skippedSolutionIds = new Set(last.skippedSolutionIds);
  localLastCompetitionEventId = last.lastCompetitionEventId;
  localIncEventId = last.incEventId;

  const stream = await getContestStreamState();
  alignLocalStateWithStream(stream);
  localLastCompetitionEventId = last.lastCompetitionEventId;
  localIncEventId = last.incEventId;

  log.info('ready to start grabbing events', { uk, producerId, streamRevision: last.streamRevision });
  await sleep(2000);

  let pushSuccess = true;
  while (true) {
    if (pushSuccess) {
      try {
        await grabEvents();
      } catch (e) {
        log.error('grab events failed:', e);
        continue;
      }
    } else {
      log.info('skip grab due to last push failed', { uk, producerId });
    }
    await pushEvents()
      .then(() => {
        pushSuccess = true;
      })
      .catch((e) => {
        pushSuccess = false;
        log.error('push events failed:', e);
      });
    await sleep(GRAB_INTERVAL);
  }
}

const program = new Command();

program
  .name('v4.js')
  .description('SRK Live Crawler OJ3 for Rankland API v2')
  .version('1.0.0')
  .arguments('<uk> <competitionId>')
  .option('-b, --srk-base <srkBasePath>', 'SRK base config path', 'srk-base.json')
  .option('-f, --user-id-filter <userIdFilterConfigPath>', 'user id filter config path')
  .option('-m, --users-merge-data <usersMergeDataConfigPath>', 'users merge data config path')
  .option('-v, --verbose', 'print append request details before each push')
  .option('-d, --debug', 'alias of --verbose')
  .action((ukArg, competitionIdArg, options) => {
    uk = normalizeText(ukArg);
    competitionId = +competitionIdArg;
    srkBasePath = options.srkBase;
    userIdFilterConfigPath = options.userIdFilter || null;
    usersMergeDataConfigPath = options.usersMergeData || null;
    verbose = Boolean(options.verbose || options.debug);
  })
  .parse(process.argv);

if (!isValidContestName(uk) || !Number.isInteger(competitionId) || competitionId <= 0) {
  console.error('valid uk (3..32 chars) and positive integer competitionId are required');
  process.exit(1);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((e) => {
    if (log) {
      log.error('fatal', e);
    } else {
      console.error('fatal', e);
    }
    process.exit(1);
  });
