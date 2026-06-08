const EVENT_FEED_VERSION = 1;

/**
 * @typedef {1} RanklandEventFeedVersion
 */

/**
 * @typedef {'complete'} RanklandEventFeedState
 */

/**
 * @typedef {'NEW_SOLUTION' | 'SOLUTION_ON_PROGRESS' | 'SOLUTION_ON_RESULT_SETTLE' | 'SOLUTION_ON_RESULT_CHANGE' | 'CONTEST_CONFIG_CHANGE'} RanklandEventType
 */

/**
 * @typedef {'PD' | 'JG' | 'CNL' | 'FZ' | 'UKE' | 'AC' | 'FB' | 'RJ' | 'WA' | 'PE' | 'TLE' | 'MLE' | 'OLE' | 'RTE' | 'NOUT' | 'CE'} RanklandResult
 */

/**
 * @typedef {'S' | 'MS' | 'US' | 'NS'} RanklandTimeUnit
 */

/**
 * @typedef {Object} RanklandTimeDuration
 * @property {string} value
 * @property {RanklandTimeUnit} unit
 */

/**
 * First JSONL line. Describes the complete feed file.
 *
 * @typedef {Object} RanklandEventFeedMetadata
 * @property {RanklandEventFeedVersion} eventFeedVersion
 * @property {RanklandEventFeedState} state
 * @property {string} [uk]
 * @property {string} createdAt
 */

/**
 * Second JSONL line. Uses natural SRK JSON fields.
 *
 * @typedef {Object} RanklandInitialContestConfig
 * @property {string} name
 * @property {Object} contest
 * @property {Object[]} problems
 * @property {Object[]} users
 * @property {Object[]} [markers]
 * @property {Object[]} [series]
 * @property {Object} [sorter]
 * @property {Array<string | Object>} [contributors]
 */

/**
 * Rankland contest event feed line.
 *
 * @typedef {Object} RanklandFeedEvent
 * @property {number} eventId
 * @property {RanklandEventType} type
 * @property {{ solutionId: number, userId: string, problemAlias: string, time: RanklandTimeDuration }} [newSolutionData]
 * @property {{ solutionId: number, percentageProgress: number }} [solutionOnProgressData]
 * @property {{ solutionId: number, result: RanklandResult, time: RanklandTimeDuration }} [solutionOnResultSettleData]
 * @property {{ solutionId: number, previousResult: RanklandResult, result: RanklandResult, time: RanklandTimeDuration }} [solutionOnResultChangeData]
 * @property {{ changedFields: Object }} [contestConfigChangeData]
 */

module.exports = {
  EVENT_FEED_VERSION,
};
