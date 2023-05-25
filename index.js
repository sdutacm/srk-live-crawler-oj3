// const mysql = require('mysql2');
const mysql = require('mysql2/promise');
const fs = require('fs-extra');
const axios = require('axios');
const { logger, initLogger } = require('./utils/logger');
const { numberToAlphabet, sleep } = require('./utils');

const isDev = process.env.NODE_ENV === 'development';

let log;
let dbConf = {};
if (isDev) {
  dbConf = require('./configs/oj-db.dev');
} else {
  dbConf = require('./configs/oj-db.prod');
}

const MAX_MYSQL_POOL_CONNECTION = 2;
const GRAB_LIMIT = 100;
const GRAB_INTERVAL = 2 * 1000;
const RL_API_BASE = 'https://rl.mushan.top';

axios.defaults.baseURL = RL_API_BASE;
axios.defaults.headers.common['algoux'] = 'rankland';

let conn;

async function query(sql, params) {
  const SQL = conn.format(sql, params);
  isDev && log.info('[sql.start]', SQL);
  const _start = Date.now();
  const [rows] = await conn.query(SQL);
  isDev && log.info(`[sql.done]  ${Date.now() - _start}ms`);
  return rows;
}

function init() {
  if (!conn) {
    conn = mysql.createPool({
      ...dbConf,
      waitForConnections: true,
      connectionLimit: MAX_MYSQL_POOL_CONNECTION,
      queueLimit: 0,
    });
  }
}

// logic

let id;
let competitionId;
let last = {
  lastSolutionId: 0,
  fbSolutionIdMap: {},
};
let competitionDetail;
let problemMap = {};

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

  // temp (river Pending)
  RPD: -1,
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

function syncLast() {
  fs.ensureDirSync('./data');
  fs.writeJSONSync(`./data/${competitionId}_${id}.json`, last, { spaces: 2 });
}

function isConfirmedResult(solution) {
  return [
    ESolutionResult.AC,
    ESolutionResult.TLE,
    ESolutionResult.MLE,
    ESolutionResult.WA,
    ESolutionResult.RTE,
    ESolutionResult.OLE,
    ESolutionResult.CE,
    ESolutionResult.PE,
    ESolutionResult.SE,
  ].includes(+solution.result);
}

function isValidResult(solution) {
  return [
    ESolutionResult.AC,
    ESolutionResult.TLE,
    ESolutionResult.MLE,
    ESolutionResult.WA,
    ESolutionResult.RTE,
    ESolutionResult.OLE,
    ESolutionResult.PE,
  ].includes(+solution.result);
}

async function grabCompetitionDetail() {
  const res = await query(`SELECT * FROM competition WHERE competition_id=? LIMIT 1`, [
    competitionId,
  ]);
  if (!res.length) {
    throw new Error('competition not found');
  }
  competitionDetail = {
    competitionId: +res[0].competition_id,
    title: res[0].title,
    startAt: res[0].start_at,
  };
  log.info('competitionDetail', competitionDetail);
  return competitionDetail;
}

async function grabProblemMap() {
  const res = await query(
    `SELECT * FROM competition_problem WHERE competition_id=? ORDER BY \`index\` ASC`,
    [competitionId],
  );
  const map = {};
  res.forEach((item) => {
    map[item.problem_id] = {
      problemId: +item.problem_id,
      index: +item.index,
      alias: numberToAlphabet(+item.index),
    };
  });
  problemMap = map;
  log.info('problemMap', problemMap);
  return map;
}

async function grabSolutions() {
  log.info('grab solutions after', last.lastSolutionId);
  const res = await query(
    `SELECT solution_id AS solutionId, user_id AS userId, problem_id AS problemId, result, sub_time AS submittedAt FROM solution WHERE solution_id>? and competition_id=? ORDER BY solution_id ASC LIMIT ?`,
    [last.lastSolutionId, competitionId, GRAB_LIMIT],
  );
  let solutions = [];
  for (let item of res) {
    if (isConfirmedResult(item)) {
      solutions.push(item);
    } else {
      log.info('skip cuz result is unconfirmed', item.solutionId);
      break;
    }
  }

  if (!solutions.length) {
    log.info('no new confirmed solutions, skip');
    return;
  }

  const nextLastSolutionId = res[res.length - 1].solutionId;
  const nextFbSolutionIdMap = { ...last.fbSolutionIdMap };
  solutions = solutions
    .filter((item) => isValidResult(item))
    .map((item) => {
      const problem = problemMap[item.problemId];
      if (!problem) {
        log.info('skip cuz problem not found', item.solutionId, item.problemId);
        return null;
      }
      const problemAlias = problem.alias;
      const srkResult = oj2SrkResultMap[item.result] || 'UKE';
      const isFb = srkResult === 'AC' && !nextFbSolutionIdMap[problemAlias];
      if (isFb) {
        log.info('grabbed FB', problemAlias, item.solutionId, item.userId);
        nextFbSolutionIdMap[problemAlias] = item.solutionId;
      }
      return {
        ...item,
        problemAlias: problemMap[item.problemId].alias,
        isFb,
        srkResult: isFb ? 'FB' : srkResult,
        submissionSecs: Math.floor((item.submittedAt - competitionDetail.startAt) / 1000),
      };
    })
    .filter(Boolean);
  log.info(
    `grabbed ${solutions.length} valid solutions:`,
    solutions.map((item) => item.solutionId).join(','),
  );
  // push to rankland
  const postData = solutions.map((item) => ({
    id: item.solutionId,
    problemID: item.problemAlias,
    memberID: `${item.userId}`,
    result: item.srkResult,
    submissionTime: item.submissionSecs,
  }));

  try {
    // console.log('RL -> postData', postData);
    const postRes = await axios.post(`ranking/record/${id}`, postData);
    if (!(postRes.data.code === 0)) {
      console.log('RL resp:', postRes.data);
      throw new Error('API rejected with ' + postRes.data.code);
    }
    last.lastSolutionId = nextLastSolutionId;
    last.fbSolutionIdMap = nextFbSolutionIdMap;
    syncLast();
    log.info('completed grabbing. next last:', last);
  } catch (e) {
    log.error('skip this round grabbing cuz posting data to RL failed:', e);
  }
}

async function main() {
  initLogger(id);
  log = logger.getLogger(isDev ? 'dev' : 'prod');
  init();
  log.info('start', id, competitionId);
  try {
    last = fs.readJSONSync(`./data/${competitionId}_${id}.json`);
  } catch (e) {
    log.info('no last data');
  }

  await grabCompetitionDetail();
  await grabProblemMap();
  while (true) {
    await grabSolutions();
    await sleep(GRAB_INTERVAL);
  }
}

id = process.argv[2];
competitionId = +process.argv[3];
if (!id || !competitionId) {
  console.error('id required');
  process.exit(1);
}
main()
  .then(() => {
    log.info('done');
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
