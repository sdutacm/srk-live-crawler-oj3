// const mysql = require('mysql2');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const Axios = require('axios');
const dayjs = require('dayjs');
const _ = require('lodash');
const { io } = require('socket.io-client');
const { Command } = require('commander');
const { logger, initLogger } = require('./utils/logger');
const { numberToAlphabet, sleep } = require('./utils');
const {
  rankland_live_contest_producer,
  rankland_live_contest_common,
} = require('./proto/rankland_live_contest_producer');

const isDev = process.env.NODE_ENV === 'development';

const MAX_MYSQL_POOL_CONNECTION = 2;
const GRAB_LIMIT = 100;
const GRAB_INTERVAL = 100;

let log;
let dbConf = {};
let rlConf = {};
if (isDev) {
  dbConf = require('./configs/oj-db.dev');
  rlConf = require('./configs/rl.dev');
} else {
  dbConf = require('./configs/oj-db.prod');
  rlConf = require('./configs/rl.prod');
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
    if (!response.data || typeof response.data !== 'object' || !('success' in response.data)) {
      throw new Error('Invalid response');
    }
    if (!response.data.success) {
      const e = new Error(`API Error: ${response.data.msg} ${response.data.code}`);
      e.code = response.data.code;
      e.msg = response.data.msg;
      throw e;
    }
    return response.data.data;
  },
  (error) => {
    throw error;
  },
);

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
      socket = io(`${rlConf.socketIOBase}/producer`, {
        transports: ['websocket'],
        path: rlConf.socketIOPath,
        auth: {
          token: rlConf.authToken,
          id: `${os.hostname()}_${process.pid}`,
          alias,
        },
      });

      socket.on('connect', () => {
        log.info('socket.io producer connected'), socket.id;
        rs();
      });
      socket.on('disconnect', () => {
        log.info('socket.io producer disconnected');
      });
      socket.on('connect_error', (e) => {
        log.error('socket.io producer connect error', e);
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
};
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

function getTimeDurationMS(time) {
  if (typeof time === 'number' || typeof time === 'string') {
    time = new Date(time);
  }
  return time.getTime() - competitionDetail.startAt.getTime();
}

function getProperTimeDuration(durationMS) {
  // try h, min, s, ms
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

function syncLast() {
  fs.ensureDirSync('./data_v3');
  fs.writeJSONSync(`./data_v3/${competitionId}_${alias}.json`, last, { spaces: 2 });
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
  contest = {
    title: competitionDetail.title,
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
    const organization = info.subname
      ? info.subname
      : competitionDetail.isTeam
      ? `${info.members.map((m) => `${m.realName}`).join(' / ')}`
      : `${info.class} ${info.realName}`;
    const user = JSON.parse(
      JSON.stringify({
        id,
        name: info.nickname,
        official: !(item.unofficial_participation === true || item.unofficial_participation === 1),
        organization,
        x_slogan: info.slogan,
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
  let membersExtra = [];
  if (usersMergeDataConfigPath) {
    try {
      membersExtra = fs.readJSONSync(usersMergeDataConfigPath) || [];
      log.info('using users merge data from:', usersMergeDataConfigPath);
    } catch (e) {
      log.warn('failed to read users merge data config:', e.message);
    }
  } else {
    if (fs.existsSync(path.join('extra', `${competitionId}_members.json`))) {
      log.info('using extra members data from:', path.join('extra', `${competitionId}_members.json`));
      membersExtra = fs.readJSONSync(path.join('extra', `${competitionId}_members.json`), { throws: false }) || [];
    }
  }
  const members = users.map((user) =>
    _.merge(
      {},
      user,
      membersExtra.find((m) => m.id === user.id),
    ),
  );
  const srk = _.merge(srkBase, {
    contest,
    problems,
    members,
  });
  const data = {
    alias,
    name: contest.title,
    ...srk,
  };
  let existed;
  try {
    existed = await req.get(`/getLiveContest`, {
      params: {
        alias,
      },
    });
  } catch (e) {
    if (e.code === 100001) {
      existed = null;
    } else {
      throw e;
    }
  }
  if (existed) {
    await req.post(`/updateLiveContest`, data);
  } else {
    await req.post(`/createLiveContest`, data);
  }
  log.info('sync contest done');
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
    item._eventId = ++localIncEventId;
    if (item.event === CompetitionEvent.SubmitSolution) {
      item.createdAt = item.detail.time ? new Date(item.detail.time) : item.createdAt;
    }
    eventBuff.push(item);
  }

  if (!res.length) {
    // log.info('no new events, skip');
    return;
  }

  log.info('grabbed events:', res.length);
  localLastCompetitionEventId = res[res.length - 1].competitionEventId;
}

// function encodeProducerEvent(event) {
//   return rankland_live_contest_producer.ProducerEvent.encode(event).finish();
// }

function pushEvents() {
  if (!eventBuff.length) {
    // log.info('no events to push');
    return Promise.resolve();
  }
  log.info(`pushing ${eventBuff.length} events`);
  const batchData = eventBuff.map((item) => {
    switch (item.event) {
      case CompetitionEvent.SubmitSolution: {
        if (!problemMap[item.problemId]) {
          // throw new Error(`Unknown problem alias for problem ${item.problemId} from solution ${item.solutionId}`);
          console.warn(`Unknown problem alias for problem ${item.problemId} from solution ${item.solutionId}. Has this problem been deleted?`);
          return null;
        }
        return {
          eventId: item._eventId,
          type: rankland_live_contest_common.EventType.NEW_SOLUTION,
          newSolutionData: {
            solutionId: item.solutionId,
            userId: `${item.userId}`,
            problemAlias: problemMap[item.problemId].alias,
            time: {
              value: getTimeDurationMS(item.createdAt),
              unit: rankland_live_contest_common.TimeUnit.MS,
            },
          },
        };
      }
      case CompetitionEvent.JudgeProgress: {
        return {
          eventId: item._eventId,
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
          eventId: item._eventId,
          type: rankland_live_contest_common.EventType.SOLUTION_ON_RESULT_SETTLE,
          solutionOnResultSettleData: {
            solutionId: item.solutionId,
            result:
              rankland_live_contest_common.Result[oj2SrkResultMap[item.detail.result] || 'UKE'],
            time: {
              value: getTimeDurationMS(item.createdAt),
              unit: rankland_live_contest_common.TimeUnit.MS,
            },
          },
        };
      }
      case CompetitionEvent.SolutionResultChange: {
        return {
          eventId: item._eventId,
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
              value: getTimeDurationMS(item.createdAt),
              unit: rankland_live_contest_common.TimeUnit.MS,
            },
          },
        };
      }
    }
  }).filter(Boolean);

  return new Promise((resolve, reject) => {
    socket.timeout(60000).emit(
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

  log.info('start', alias, competitionId, { userIdFilterConfigPath, usersMergeDataConfigPath });
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
  // create or update contest
  await syncContest();
  log.info('ready to start grabbing events');
  await sleep(2000);

  try {
    last = fs.readJSONSync(`./data_v3/${competitionId}_${alias}.json`);
  } catch (e) {
    log.info('no last data');
  }
  localLastCompetitionEventId = last.lastCompetitionEventId;
  localIncEventId = last.incEventId;

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
      log.info('skip grab due to last push failed');
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
  .name('v3.js')
  .description('SRK Live Crawler OJ3')
  .version('1.0.0')
  .arguments('<alias> <competitionId>')
  .option('-b, --srk-base <srkBasePath>', 'SRK 基础配置文件路径（可选，默认: srk-base.json）', 'srk-base.json')
  .option('-f, --user-id-filter <userIdFilterConfigPath>', '用户 ID 过滤配置文件路径（可选）')
  .option('-m, --users-merge-data <usersMergeDataConfigPath>', '用户信息合并数据配置文件路径（可选）')
  .action((aliasArg, competitionIdArg, options) => {
    alias = aliasArg;
    competitionId = +competitionIdArg;
    srkBasePath = options.srkBase;
    userIdFilterConfigPath = options.userIdFilter || null;
    usersMergeDataConfigPath = options.usersMergeData || null;
  })
  .parse(process.argv);

main()
  .then(() => {
    process.exit(0);
  })
  .catch((e) => {
    log.error('fatal', e);
    process.exit(1);
  });
