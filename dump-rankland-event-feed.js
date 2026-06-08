const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs-extra');
const dayjs = require('dayjs');
const _ = require('lodash');
const { Command } = require('commander');
const { numberToAlphabet } = require('./utils');
const { EVENT_FEED_VERSION } = require('./rankland-event-feed.schema');

/** @typedef {import('./rankland-event-feed.schema').RanklandEventFeedMetadata} RanklandEventFeedMetadata */
/** @typedef {import('./rankland-event-feed.schema').RanklandInitialContestConfig} RanklandInitialContestConfig */
/** @typedef {import('./rankland-event-feed.schema').RanklandFeedEvent} RanklandFeedEvent */
/** @typedef {import('./rankland-event-feed.schema').RanklandTimeDuration} RanklandTimeDuration */

const isDev = process.env.NODE_ENV === 'development';
const MAX_MYSQL_POOL_CONNECTION = 2;

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

const oj2RanklandResultMap = {
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

const ranklandResultNames = new Set([
  'PD',
  'JG',
  'CNL',
  'FZ',
  'UKE',
  'AC',
  'FB',
  'RJ',
  'WA',
  'PE',
  'TLE',
  'MLE',
  'OLE',
  'RTE',
  'NOUT',
  'CE',
]);

const CONVERTED_EVENTS = new Set([
  CompetitionEvent.SubmitSolution,
  CompetitionEvent.JudgeProgress,
  CompetitionEvent.SolutionResultSettle,
  CompetitionEvent.SolutionResultChange,
]);

const PRIVATE_USER_FIELDS = ['banned', 'broadcasterToken'];

let conn;

async function initDb() {
  const dbConf = isDev ? require('./configs/oj-db.dev') : require('./configs/oj-db.prod');
  conn = mysql.createPool({
    ...dbConf,
    waitForConnections: true,
    connectionLimit: MAX_MYSQL_POOL_CONNECTION,
    queueLimit: 0,
  });
}

async function closeDb() {
  if (conn) {
    await conn.end();
    conn = null;
  }
}

async function query(sql, params) {
  const [rows] = await conn.query(sql, params);
  return rows;
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isValidContestName(value) {
  const text = normalizeText(value);
  return text.length >= 3 && text.length <= 32;
}

function normalizePositiveInteger(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function parseJson(value, fallback, warnings, context) {
  if (value === null || value === undefined || value === '') {
    return fallback();
  }
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch (e) {
    warnings.push({
      kind: 'json-parse',
      ...context,
      message: e.message,
    });
    return fallback();
  }
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

function getContestTitle(competitionDetail, uk, warnings) {
  const title = normalizeText(competitionDetail.title);
  if (title) {
    return title;
  }
  const fallbackTitle = normalizeText(uk) || `contest-${competitionDetail.competitionId}`;
  warnings.push({
    kind: 'contest-title-fallback',
    message: 'contest title is empty, fallback to generated title',
    fallbackTitle,
  });
  return fallbackTitle;
}

function getContestName(competitionDetail, uk, warnings) {
  const title = normalizeText(competitionDetail.title);
  if (isValidContestName(title)) {
    return title;
  }
  if (isValidContestName(uk)) {
    warnings.push({
      kind: 'contest-name-fallback',
      message: 'contest title is not a valid Rankland name, fallback to uk',
      title: competitionDetail.title,
      uk,
    });
    return uk;
  }
  const fallbackName = `contest-${competitionDetail.competitionId}`.slice(0, 32);
  warnings.push({
    kind: 'contest-name-fallback',
    message: 'contest title and uk are not valid Rankland names, fallback to generated name',
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

function getTimeDurationMS(time, competitionDetail) {
  if (typeof time === 'number' || typeof time === 'string') {
    time = new Date(time);
  }
  return time.getTime() - competitionDetail.startAt.getTime();
}

function msToNsDuration(durationMS) {
  return {
    value: (BigInt(Math.trunc(durationMS)) * 1000000n).toString(),
    unit: 'NS',
  };
}

function getEventTimeDuration(time, item, competitionDetail, warnings) {
  const durationMS = getTimeDurationMS(time, competitionDetail);
  if (Number.isFinite(durationMS) && durationMS >= 0) {
    return msToNsDuration(durationMS);
  }
  warnings.push({
    kind: 'event-time-clamped',
    competitionEventId: item.competitionEventId,
    solutionId: item.solutionId,
    event: item.event,
    durationMS,
    message: 'clamped invalid event time to contest start',
  });
  return msToNsDuration(0);
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getPercentageProgress(detail, item, warnings) {
  const current = Number(detail && detail.current);
  const total = Number(detail && detail.total);
  const safeCurrent = Number.isFinite(current) ? current : 0;
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 1;
  const rawPercentage = Math.floor((safeCurrent / safeTotal) * 100);
  const percentageProgress = clampNumber(rawPercentage, 0, 100);
  if (percentageProgress !== rawPercentage) {
    warnings.push({
      kind: 'progress-clamped',
      competitionEventId: item.competitionEventId,
      solutionId: item.solutionId,
      event: item.event,
      current: detail && detail.current,
      total: detail && detail.total,
      rawPercentage,
      percentageProgress,
      message: 'clamped invalid progress percentage',
    });
  }
  return percentageProgress;
}

function getRawResultName(ojResult, item, field, warnings) {
  const normalizedStringResult = typeof ojResult === 'string' ? ojResult.trim().toUpperCase() : '';
  const resultName = ranklandResultNames.has(normalizedStringResult)
    ? normalizedStringResult
    : oj2RanklandResultMap[ojResult] || 'UKE';
  const fallbackName = computedResultFallbackMap[resultName];
  const rawResultName = fallbackName || resultName;
  if (fallbackName) {
    warnings.push({
      kind: 'computed-result-converted',
      competitionEventId: item.competitionEventId,
      solutionId: item.solutionId,
      event: item.event,
      field,
      resultName,
      rawResultName,
      message: 'converted computed result to raw-compatible result',
    });
  }
  return rawResultName;
}

function buildProblemRows(problemRows) {
  const problems = [];
  const problemMap = {};
  for (const item of problemRows) {
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
    problems.push(problem);
    problemMap[item.problem_id] = problem;
  }
  return { problems, problemMap };
}

function buildUserRows(participantRows, competitionDetail, userIdFilter, warnings) {
  const users = [];
  const userMap = {};
  for (const item of participantRows) {
    const id = `${item.user_id}`;
    if (userIdFilter && !userIdFilter.includes(id)) {
      continue;
    }
    const info = parseJson(item.info, () => ({}), warnings, {
      table: 'competition_user',
      id,
      field: 'info',
    });
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
    users.push(user);
    userMap[id] = user;
  }
  return { users, userMap };
}

function loadUsersExtra(competitionId, usersMergeDataConfigPath, warnings) {
  if (usersMergeDataConfigPath) {
    try {
      return fs.readJSONSync(usersMergeDataConfigPath) || [];
    } catch (e) {
      warnings.push({
        kind: 'users-merge-data-read-failed',
        path: usersMergeDataConfigPath,
        message: e.message,
      });
      return [];
    }
  }
  const defaultPath = path.join('extra', `${competitionId}_members.json`);
  if (!fs.existsSync(defaultPath)) {
    return [];
  }
  return fs.readJSONSync(defaultPath, { throws: false }) || [];
}

function buildMergedUsers(users, usersExtra) {
  const extraById = new Map((usersExtra || []).map((user) => [String(user.id), user]));
  return users.map((user) => {
    const merged = mergeReplacingArrays(user, extraById.get(user.id));
    for (const field of PRIVATE_USER_FIELDS) {
      delete merged[field];
    }
    return merged;
  });
}

function buildInitialConfig({
  uk,
  competitionId,
  competitionDetail,
  competitionSettings,
  problemRows,
  participantRows,
  srkBasePath,
  userIdFilter,
  usersMergeDataConfigPath,
  warnings,
}) {
  const srkBase = fs.readJSONSync(srkBasePath);
  const { problems, problemMap } = buildProblemRows(problemRows);
  const { users, userMap } = buildUserRows(participantRows, competitionDetail, userIdFilter, warnings);
  const usersExtra = loadUsersExtra(competitionId, usersMergeDataConfigPath, warnings);
  const mergedUsers = buildMergedUsers(users, usersExtra);
  const initialConfig = mergeReplacingArrays(srkBase, {
    name: getContestName(competitionDetail, uk, warnings),
    contest: {
      title: getContestTitle(competitionDetail, uk, warnings),
      startAt: dayjs(competitionDetail.startAt).format('YYYY-MM-DDTHH:mm:ssZ'),
      duration: getProperTimeDuration(getTimeDurationMS(competitionDetail.endAt, competitionDetail)),
      frozenDuration: getProperTimeDuration((competitionSettings.frozenLength || 0) * 1000),
    },
    problems,
    users: mergedUsers,
  });
  return {
    initialConfig,
    problemMap,
    userMap,
  };
}

function markSkippedSolution(item, skippedSolutionIds, warnings, reason) {
  const solutionId = normalizePositiveInteger(item.solutionId);
  if (solutionId) {
    skippedSolutionIds.add(solutionId);
  }
  warnings.push({
    kind: 'solution-event-skipped',
    competitionEventId: item.competitionEventId,
    solutionId: item.solutionId,
    event: item.event,
    reason,
  });
}

function shouldSkipChildEvent(item, skippedSolutionIds, warnings) {
  const solutionId = normalizePositiveInteger(item.solutionId);
  if (!solutionId) {
    warnings.push({
      kind: 'child-event-skipped',
      competitionEventId: item.competitionEventId,
      solutionId: item.solutionId,
      event: item.event,
      reason: 'invalid solution id',
    });
    return true;
  }
  if (skippedSolutionIds.has(solutionId)) {
    warnings.push({
      kind: 'child-event-skipped',
      competitionEventId: item.competitionEventId,
      solutionId,
      event: item.event,
      reason: 'solution was skipped',
    });
    return true;
  }
  return false;
}

function parseEventRow(row, warnings) {
  const item = {
    competitionEventId: row.competitionEventId,
    event: row.event,
    solutionId: row.solutionId,
    detail: parseJson(row.detail, () => ({}), warnings, {
      table: 'competition_event',
      id: row.competitionEventId,
      field: 'detail',
    }),
    userId: row.userId,
    problemId: row.problemId,
    createdAt: row.createdAt,
  };
  if (item.event === CompetitionEvent.SubmitSolution) {
    item.createdAt = item.detail && item.detail.time ? new Date(item.detail.time) : item.createdAt;
  }
  return item;
}

function createFeedEvent(item, context) {
  const { competitionDetail, problemMap, userMap, userIdFilter, skippedSolutionIds, warnings } = context;
  switch (item.event) {
    case CompetitionEvent.SubmitSolution: {
      if (!normalizePositiveInteger(item.solutionId)) {
        markSkippedSolution(item, skippedSolutionIds, warnings, 'invalid solution id');
        return null;
      }
      if (!problemMap[item.problemId]) {
        markSkippedSolution(item, skippedSolutionIds, warnings, `unknown problem ${item.problemId}`);
        return null;
      }
      const userId = `${item.userId}`;
      if (userIdFilter && !userMap[userId]) {
        markSkippedSolution(item, skippedSolutionIds, warnings, `user ${userId} is filtered out`);
        return null;
      }
      return {
        type: 'NEW_SOLUTION',
        newSolutionData: {
          solutionId: item.solutionId,
          userId,
          problemAlias: problemMap[item.problemId].alias,
          time: getEventTimeDuration(item.createdAt, item, competitionDetail, warnings),
        },
      };
    }
    case CompetitionEvent.JudgeProgress: {
      if (shouldSkipChildEvent(item, skippedSolutionIds, warnings)) {
        return null;
      }
      return {
        type: 'SOLUTION_ON_PROGRESS',
        solutionOnProgressData: {
          solutionId: item.solutionId,
          percentageProgress: getPercentageProgress(item.detail, item, warnings),
        },
      };
    }
    case CompetitionEvent.SolutionResultSettle: {
      if (shouldSkipChildEvent(item, skippedSolutionIds, warnings)) {
        return null;
      }
      return {
        type: 'SOLUTION_ON_RESULT_SETTLE',
        solutionOnResultSettleData: {
          solutionId: item.solutionId,
          result: getRawResultName(item.detail.result, item, 'result', warnings),
          time: getEventTimeDuration(item.createdAt, item, competitionDetail, warnings),
        },
      };
    }
    case CompetitionEvent.SolutionResultChange: {
      if (shouldSkipChildEvent(item, skippedSolutionIds, warnings)) {
        return null;
      }
      return {
        type: 'SOLUTION_ON_RESULT_CHANGE',
        solutionOnResultChangeData: {
          solutionId: item.solutionId,
          previousResult: getRawResultName(item.detail.previousResult, item, 'previousResult', warnings),
          result: getRawResultName(item.detail.result, item, 'result', warnings),
          time: getEventTimeDuration(item.createdAt, item, competitionDetail, warnings),
        },
      };
    }
    default:
      return null;
  }
}

function buildFeedEvents({ eventRows, competitionDetail, problemMap, userMap, userIdFilter, warnings }) {
  const events = [];
  const skippedSolutionIds = new Set();
  const unsupportedCounts = {};
  for (const row of eventRows) {
    if (!CONVERTED_EVENTS.has(row.event)) {
      unsupportedCounts[row.event] = (unsupportedCounts[row.event] || 0) + 1;
      continue;
    }
    const item = parseEventRow(row, warnings);
    const event = createFeedEvent(item, {
      competitionDetail,
      problemMap,
      userMap,
      userIdFilter,
      skippedSolutionIds,
      warnings,
    });
    if (!event) {
      continue;
    }
    events.push({
      eventId: events.length + 1,
      ...event,
    });
  }
  for (const [event, count] of Object.entries(unsupportedCounts)) {
    warnings.push({
      kind: 'unsupported-solution-event-skipped',
      event,
      count,
      message: 'event feed proto has no payload for this SDUTOJ solution event',
    });
  }
  return events;
}

async function fetchCompetitionData(competitionId) {
  const [competitionRows, settingRows, participantRows, problemRows, eventRows] = await Promise.all([
    query('SELECT * FROM competition WHERE competition_id=? LIMIT 1', [competitionId]),
    query('SELECT * FROM competition_setting WHERE competition_id=? LIMIT 1', [competitionId]),
    query(
      'SELECT * FROM competition_user WHERE competition_id=? AND role=2 AND banned=false AND status IN (1, 5, 6) ORDER BY created_at ASC',
      [competitionId],
    ),
    query('SELECT * FROM competition_problem WHERE competition_id=? ORDER BY `index` ASC', [
      competitionId,
    ]),
    query(
      "SELECT competition_event_id AS competitionEventId, event, solution_id AS solutionId, detail, user_id AS userId, problem_id AS problemId, created_at AS createdAt FROM competition_event WHERE competition_id=? AND event LIKE 'solution:%' ORDER BY competition_event_id ASC",
      [competitionId],
    ),
  ]);
  if (!competitionRows.length || !settingRows.length) {
    throw new Error('competition not found');
  }
  return {
    competitionRow: competitionRows[0],
    settingRow: settingRows[0],
    participantRows,
    problemRows,
    eventRows,
  };
}

async function buildFeed({ uk, competitionId, srkBasePath, userIdFilter, usersMergeDataConfigPath }) {
  const warnings = [];
  const { competitionRow, settingRow, participantRows, problemRows, eventRows } =
    await fetchCompetitionData(competitionId);
  const competitionDetail = {
    competitionId: +competitionRow.competition_id,
    title: competitionRow.title,
    startAt: competitionRow.start_at,
    endAt: competitionRow.end_at,
    isTeam: competitionRow.is_team === 1,
    rule: competitionRow.rule,
    spConfig: parseJson(competitionRow.sp_config, () => ({}), warnings, {
      table: 'competition',
      id: competitionId,
      field: 'sp_config',
    }),
  };
  const competitionSettings = {
    frozenLength: settingRow.frozen_length || 0,
  };
  const { initialConfig, problemMap, userMap } = buildInitialConfig({
    uk,
    competitionId,
    competitionDetail,
    competitionSettings,
    problemRows,
    participantRows,
    srkBasePath,
    userIdFilter,
    usersMergeDataConfigPath,
    warnings,
  });
  const events = buildFeedEvents({
    eventRows,
    competitionDetail,
    problemMap,
    userMap,
    userIdFilter,
    warnings,
  });
  const metadata = {
    eventFeedVersion: EVENT_FEED_VERSION,
    state: 'complete',
    uk,
    createdAt: new Date().toISOString(),
  };
  return {
    metadata,
    initialConfig,
    events,
    warnings,
  };
}

async function writeFeedJsonl(outputFile, feed) {
  await fs.ensureDir(path.dirname(outputFile));
  const lines = [feed.metadata, feed.initialConfig, ...feed.events].map((line) => JSON.stringify(line));
  await fs.writeFile(outputFile, `${lines.join('\n')}\n`, 'utf8');
}

function loadUserIdFilter(userIdFilterConfigPath, warnings) {
  if (!userIdFilterConfigPath) {
    return null;
  }
  try {
    const raw = fs.readJSONSync(userIdFilterConfigPath) || null;
    return Array.isArray(raw) ? raw.map((id) => `${id}`) : null;
  } catch (e) {
    warnings.push({
      kind: 'user-id-filter-read-failed',
      path: userIdFilterConfigPath,
      message: e.message,
    });
    return null;
  }
}

function printWarnings(warnings) {
  for (const warning of warnings) {
    console.error('[warning]', JSON.stringify(warning));
  }
}

async function main() {
  const program = new Command();
  program
    .name('dump-rankland-event-feed.js')
    .description('Dump an SDUTOJ contest to Rankland contest event feed JSONL')
    .version('1.0.0')
    .arguments('<uk> <competitionId> <outputFile>')
    .option('-b, --srk-base <srkBasePath>', 'SRK base config path', 'srk-base.json')
    .option('-f, --user-id-filter <userIdFilterConfigPath>', 'user id filter config path')
    .option('-m, --users-merge-data <usersMergeDataConfigPath>', 'users merge data config path')
    .action((ukArg, competitionIdArg, outputFileArg, options) => {
      program.uk = normalizeText(ukArg);
      program.competitionId = Number(competitionIdArg);
      program.outputFile = outputFileArg;
      program.srkBasePath = options.srkBase;
      program.userIdFilterConfigPath = options.userIdFilter || null;
      program.usersMergeDataConfigPath = options.usersMergeData || null;
    })
    .parse(process.argv);

  if (!isValidContestName(program.uk) || !Number.isInteger(program.competitionId) || program.competitionId <= 0 || !program.outputFile) {
    console.error('valid uk (3..32 chars), positive integer competitionId, and outputFile are required');
    program.outputHelp({ error: true });
    process.exit(1);
  }

  const startupWarnings = [];
  const userIdFilter = loadUserIdFilter(program.userIdFilterConfigPath, startupWarnings);

  await initDb();
  try {
    const feed = await buildFeed({
      uk: program.uk,
      competitionId: program.competitionId,
      srkBasePath: program.srkBasePath,
      userIdFilter,
      usersMergeDataConfigPath: program.usersMergeDataConfigPath,
    });
    feed.warnings.unshift(...startupWarnings);
    await writeFeedJsonl(program.outputFile, feed);
    printWarnings(feed.warnings);
    console.log(
      `dumped competition ${program.competitionId} Rankland event feed to ${program.outputFile}: users=${feed.initialConfig.users.length}, problems=${feed.initialConfig.problems.length}, events=${feed.events.length}, warnings=${feed.warnings.length}`,
    );
  } finally {
    await closeDb();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}

module.exports = {
  CompetitionEvent,
  buildFeed,
  buildFeedEvents,
  writeFeedJsonl,
};
