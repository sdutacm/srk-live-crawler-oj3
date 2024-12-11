// const mysql = require('mysql2');
const mysql = require('mysql2/promise');
const fs = require('fs-extra');
const os = require('os');
const axios = require('axios');
const { io } = require('socket.io-client');
const { logger, initLogger } = require('./utils/logger');
const { numberToAlphabet, sleep } = require('./utils');
const {
  rankland_live_contest_producer,
  rankland_live_contest_common,
} = require('./proto/rankland_live_contest_producer');

const isDev = process.env.NODE_ENV === 'development';

// const RL_API_BASE = 'https://acm.sdut.edu.cn/rl_api_v2';
const RL_API_BASE = 'https://acm.sdut.edu.cn/rankland/api';
const RL_SOCKET_IO_BASE = 'https://acm.sdut.edu.cn';
const RL_SOCKET_IO_PATH = '/rankland_web/socket.io';
const AUTH_TOKEN = 'rankland_';

let log;
let dbConf = {};
if (isDev) {
  dbConf = require('./configs/oj-db.dev');
} else {
  dbConf = require('./configs/oj-db.prod');
}

const MAX_MYSQL_POOL_CONNECTION = 2;
const GRAB_LIMIT = 100;
const GRAB_INTERVAL = 200;

axios.defaults.baseURL = RL_API_BASE;
axios.defaults.headers.common['x-token'] = AUTH_TOKEN;

let socket;
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
  return new Promise((rs, rj) => {
    if (!conn) {
      conn = mysql.createPool({
        ...dbConf,
        waitForConnections: true,
        connectionLimit: MAX_MYSQL_POOL_CONNECTION,
        queueLimit: 0,
      });
    }

    if (!socket) {
      socket = io(`${RL_SOCKET_IO_BASE}/producer`, {
        transports: ['websocket'],
        path: RL_SOCKET_IO_PATH,
        auth: {
          token: AUTH_TOKEN,
          id: `${os.hostname()}_${process.pid}`,
          alias,
        },
      });

      socket.on('connect', () => {
        console.log('socket.io connected'), socket.id;
        rs();
      });
      socket.on('disconnect', () => {
        console.log('socket.io disconnected');
      });
      socket.on('connect_error', (e) => {
        console.error('socket.io connect_error', e);
        rj(e);
      });
    }
  });
}

// logic

let alias;
let competitionId;
let last = {
  incEventId: 0,
  lastCompetitionEventId: 0,
  lastSolutionId: 0,
  solutionLatestResultMap: {},
  solutionEventBuffMap: {},
};
let localLastCompetitionEventId = 0;
let localLastSolutionId = 0;
let localIncEventId = 0;
let competitionDetail;
let problemMap = {};
let userMap = {};
let userIdFilter = null;
let solutionLatestResultMap = /** <solutionId, ESolutionResult> */ {};
let solutionEventBuffMap = /** <solutionId, EventDbRes[]> */ {};
let eventBuff = [];

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

function syncLast() {
  fs.ensureDirSync('./data_v2');
  fs.writeJSONSync(`./data_v2/${competitionId}_${alias}.json`, last, { spaces: 2 });
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

function isSolutionCreated(solutionId) {
  return solutionLatestResultMap[solutionId] !== undefined;
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

async function grabUserMap() {
  const res = await query(
    `SELECT * FROM competition_user WHERE competition_id=? AND role=2 AND banned=false AND status IN (1, 5, 6) ORDER BY user_id ASC`,
    [competitionId],
  );
  const parse = (str, fallback) => {
    try {
      return JSON.parse(str);
    } catch (e) {
      return fallback();
    }
  };
  const map = {};
  res.forEach((item) => {
    map[item.user_id] = {
      userId: +item.user_id,
      info: parse(item.info, () => ({})),
      unofficialParticipation: item.unofficial_participation,
    };
  });
  userMap = map;
  log.info('userMap size', Object.keys(userMap).length);
  return map;
}

function getTimeDuration(time) {
  if (typeof time === 'number' || typeof time === 'string') {
    time = new Date(time);
  }
  return time.getTime() - competitionDetail.startAt.getTime();
}

async function grabSolutions() {
  log.info('grab solutions after', localLastSolutionId);
  const res = await query(
    `SELECT solution_id AS solutionId, user_id AS userId, problem_id AS problemId, result, sub_time AS submittedAt FROM solution WHERE solution_id>? AND competition_id=? ORDER BY solution_id ASC LIMIT ?`,
    [localLastSolutionId, competitionId, GRAB_LIMIT],
  );
  for (let item of res) {
    const solutionId = item.solutionId;
    solutionLatestResultMap[solutionId] = item.result;
    eventBuff.push({
      competitionEventId: 0,
      event: CompetitionEvent.SubmitSolution,
      detail: JSON.stringify({
        time: item.submittedAt,
      }),
      userId: item.userId,
      problemId: item.problemId,
      solutionId,
      createdAt: item.submittedAt,
    });
  }

  if (!res.length) {
    log.info('no new solutions');
  }

  log.info('flushing solution buff');
  for (const solutionIdKey in solutionEventBuffMap) {
    const solutionId = +solutionIdKey;
    if (isSolutionCreated(solutionId)) {
      const buff = solutionEventBuffMap[solutionId] || [];
      log.info('solution is known', solutionId, 'flushing', buff.length, 'buff');
      for (let item of buff) {
        eventBuff.push(item);
        if (item.event === CompetitionEvent.SolutionResultSettle) {
          solutionLatestResultMap[solutionId] = item.detail.result;
        } else if (item.event === CompetitionEvent.SolutionResultChange) {
          item.detail.previousResult = solutionLatestResultMap[solutionId];
          solutionLatestResultMap[solutionId] = item.detail.result;
        }
      }
      delete solutionEventBuffMap[solutionId];
    }
  }

  res.length > 0 && (localLastSolutionId = res[res.length - 1].solutionId);
}

async function grabEvents() {
  log.info('grab competition events after', localLastCompetitionEventId);
  const res = await query(
    `SELECT competition_event_id AS competitionEventId, event, solution_id AS solutionId, detail, created_at AS createdAt FROM competition_event WHERE competition_event_id>? AND competition_id=? AND event IN (?) ORDER BY competition_event_id ASC LIMIT ?`,
    [
      localLastCompetitionEventId,
      competitionId,
      [
        CompetitionEvent.JudgeProgress,
        CompetitionEvent.SolutionResultSettle,
        CompetitionEvent.SolutionResultChange,
      ],
      GRAB_LIMIT,
    ],
  );
  for (let item of res) {
    // if (res.event === 'solution:SubmitSolution') {
    //   continue;
    // }
    try {
      item.detail = JSON.parse(item.detail);
    } catch (e) {
      item.detail = {};
    }

    const solutionId = item.solutionId;
    if (isSolutionCreated(solutionId)) {
      if (item.event === CompetitionEvent.JudgeProgress) {
        if (
          ![
            ESolutionResult.WT,
            ESolutionResult.JG,
            ESolutionResult.RPD,
            ESolutionResult.CNL,
          ].includes(solutionLatestResultMap[solutionId])
        ) {
          continue;
        }
      } else if (item.event === CompetitionEvent.SolutionResultSettle) {
        solutionLatestResultMap[solutionId] = item.detail.result;
      } else if (item.event === CompetitionEvent.SolutionResultChange) {
        item.detail.previousResult = solutionLatestResultMap[solutionId];
        solutionLatestResultMap[solutionId] = item.detail.result;
      }
      eventBuff.push(item);
    } else {
      log.info('added to buff cuz solution is unknown', solutionId, item.competitionEventId);
      const buff = solutionEventBuffMap[solutionId] || [];
      buff.push(item);
      solutionEventBuffMap[solutionId] = buff;
    }
  }

  if (!res.length) {
    log.info('no new events, skip');
    return;
  }

  localLastCompetitionEventId = res[res.length - 1].competitionEventId;
}

// function encodeProducerEvent(event) {
//   return rankland_live_contest_producer.ProducerEvent.encode(event).finish();
// }

function pushEvents() {
  if (!eventBuff.length) {
    log.info('no events to push');
    return Promise.resolve();
  }
  log.info(`pushing ${eventBuff.length} events`);
  const batchData = eventBuff.map((item) => {
    switch (item.event) {
      case CompetitionEvent.SubmitSolution: {
        return {
          eventId: ++localIncEventId,
          type: rankland_live_contest_common.EventType.NEW_SOLUTION,
          newSolutionData: {
            solutionId: item.solutionId,
            userId: `${item.userId}`,
            problemAlias: problemMap[item.problemId] ? problemMap[item.problemId].alias : '',
            time: {
              value: getTimeDuration(item.createdAt),
              unit: rankland_live_contest_common.TimeUnit.MS,
            },
          },
        };
      }
      case CompetitionEvent.JudgeProgress: {
        return {
          eventId: ++localIncEventId,
          type: rankland_live_contest_common.EventType.SOLUTION_ON_PROGRESS,
          solutionOnProgressData: {
            solutionId: item.solutionId,
            percentageProgress: Math.floor(
              ((item.detail.current || 0) / (item.detail.total || 1)) * 100,
            ),
          },
        };
      }
      case CompetitionEvent.SolutionResultSettle: {
        return {
          eventId: ++localIncEventId,
          type: rankland_live_contest_common.EventType.SOLUTION_ON_RESULT_SETTLE,
          solutionOnResultSettleData: {
            solutionId: item.solutionId,
            result:
              rankland_live_contest_common.Result[oj2SrkResultMap[item.detail.result] || 'UKE'],
            time: {
              value: getTimeDuration(item.createdAt),
              unit: rankland_live_contest_common.TimeUnit.MS,
            },
          },
        };
      }
      case CompetitionEvent.SolutionResultChange: {
        return {
          eventId: ++localIncEventId,
          type: rankland_live_contest_common.EventType.SOLUTION_ON_RESULT_CHANGE,
          solutionOnResultChangeData: {
            solutionId: item.solutionId,
            previousResult:
              rankland_live_contest_common.Result[
                oj2SrkResultMap[item.detail.previousResult] || 'UKE'
              ],
            result:
              rankland_live_contest_common.Result[oj2SrkResultMap[item.detail.result] || 'UKE'],
            time: {
              value: getTimeDuration(item.createdAt),
              unit: rankland_live_contest_common.TimeUnit.MS,
            },
          },
        };
      }
    }
  });

  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(
      'ProducerEvent',
      rankland_live_contest_producer.BatchProducerEvent.encode({
        events: batchData,
      }).finish(),
      (err, resp) => {
        if (err) {
          log.error('socket.io err', err);
          return reject(err);
        }
        log.info('socket.io resp', resp);
        if (resp.success) {
          eventBuff = [];
          last.incEventId = localIncEventId;
          last.lastCompetitionEventId = localLastCompetitionEventId;
          last.lastSolutionId = localLastSolutionId;
          last.solutionLatestResultMap = solutionLatestResultMap;
          last.solutionEventBuffMap = solutionEventBuffMap;
          syncLast();
          resolve();
        }
        reject(resp);
      },
    );
  });
}

async function main() {
  initLogger(alias);
  log = logger.getLogger(isDev ? 'dev' : 'prod');
  await init();

  log.info('start', alias, competitionId, userIdFilterConfig);
  try {
    userIdFilter = fs.readJSONSync(userIdFilterConfig) || null;
    log.info('using id filter', userIdFilter);
  } catch (e) {
    log.info('no id filter');
  }
  try {
    last = fs.readJSONSync(`./data_v2/${competitionId}_${alias}.json`);
  } catch (e) {
    log.info('no last data');
  }
  localLastCompetitionEventId = last.lastCompetitionEventId;
  localLastSolutionId = last.lastSolutionId;
  localIncEventId = last.incEventId;
  solutionLatestResultMap = last.solutionLatestResultMap;
  solutionEventBuffMap = last.solutionEventBuffMap;

  await grabCompetitionDetail();
  await grabProblemMap();
  await grabUserMap();

  let pushSuccess = true;
  while (true) {
    if (pushSuccess) {
      await grabSolutions();
      await grabEvents();
    } else {
      log.info('skip grab due to last push failed');
    }
    await pushEvents()
      .then(() => {
        pushSuccess = true;
      })
      .catch((e) => {
        pushSuccess = false;
        log.error('pushEvents failed', e);
      });
    await sleep(GRAB_INTERVAL);
  }
}

alias = process.argv[2];
competitionId = +process.argv[3];
userIdFilterConfig = process.argv[4];
if (!alias || !competitionId) {
  console.error('alias and competitionId are required');
  process.exit(1);
}
main()
  .then(() => {
    log.info('done');
    process.exit(0);
  })
  .catch((e) => {
    console.error('fatal', e);
    process.exit(1);
  });
