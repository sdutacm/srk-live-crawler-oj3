const ARCHIVE_SCHEMA = 'sdutoj.contest-archive.v1';

/**
 * @typedef {'sdutoj.contest-archive.v1'} SdutojArchiveSchema
 */

/**
 * @typedef {string | number | boolean | null} JsonPrimitive
 */

/**
 * @typedef {JsonPrimitive | JsonObject | JsonArray} JsonValue
 */

/**
 * @typedef {{ [key: string]: JsonValue }} JsonObject
 */

/**
 * @typedef {JsonValue[]} JsonArray
 */

/**
 * Parsed `competition` row.
 *
 * Field names intentionally follow the SDUTOJ database column names. Additional
 * DB columns may be present and should be treated as JSON values.
 *
 * @typedef {Object} SdutojCompetition
 * @property {number} competition_id
 * @property {string | null} [title]
 * @property {string | null} [start_at]
 * @property {string | null} [end_at]
 * @property {number | boolean | null} [is_team]
 * @property {string | number | null} [rule]
 * @property {JsonValue} [sp_config]
 */

/**
 * Parsed `competition_setting` row.
 *
 * Field names intentionally follow the SDUTOJ database column names. Additional
 * DB columns may be present and should be treated as JSON values.
 *
 * @typedef {Object} SdutojCompetitionSetting
 * @property {number} competition_id
 * @property {number | null} [frozen_length]
 */

/**
 * Parsed `competition_user` row for one participant.
 *
 * Field names intentionally follow the SDUTOJ database column names. Additional
 * DB columns may be present and should be treated as JSON values.
 *
 * @typedef {Object} SdutojParticipant
 * @property {number} competition_id
 * @property {number | string} user_id
 * @property {number | null} [role]
 * @property {number | null} [status]
 * @property {number | boolean | null} [banned]
 * @property {number | boolean | null} [unofficial_participation]
 * @property {JsonValue} [info]
 */

/**
 * Parsed `competition_problem` row.
 *
 * Field names intentionally follow the SDUTOJ database column names. Additional
 * DB columns may be present and should be treated as JSON values.
 *
 * @typedef {Object} SdutojProblem
 * @property {number} competition_id
 * @property {number} problem_id
 * @property {number | string | null} [index]
 * @property {string} alias
 * @property {string | null} [balloon_color]
 */

/**
 * Parsed `competition_event` row for one `solution:*` event.
 *
 * Field names intentionally follow the SDUTOJ database column names. Additional
 * DB columns may be present and should be treated as JSON values.
 *
 * @typedef {Object} SdutojCompetitionEvent
 * @property {number} competition_event_id
 * @property {number} competition_id
 * @property {string} event
 * @property {number | null} [solution_id]
 * @property {number | string | null} [user_id]
 * @property {number | null} [problem_id]
 * @property {JsonValue} [detail]
 * @property {string | null} [created_at]
 */

/**
 * Warning emitted when the dumper keeps an original value instead of parsing it.
 *
 * @typedef {Object} SdutojArchiveWarning
 * @property {string} table
 * @property {number | string | null} id
 * @property {string} field
 * @property {string} message
 */

/**
 * Counts for archive list fields.
 *
 * @typedef {Object} SdutojArchiveCounts
 * @property {number} participants
 * @property {number} problems
 * @property {number} events
 */

/**
 * Complete SDUTOJ contest archive dump.
 *
 * @typedef {Object} SdutojCompetitionArchive
 * @property {SdutojArchiveSchema} schema
 * @property {string} dumped_at
 * @property {number} competition_id
 * @property {SdutojCompetition} competition
 * @property {SdutojCompetitionSetting} competition_setting
 * @property {SdutojParticipant[]} participants
 * @property {SdutojProblem[]} problems
 * @property {SdutojCompetitionEvent[]} events
 * @property {SdutojArchiveCounts} counts
 * @property {SdutojArchiveWarning[]} warnings
 */

module.exports = {
  ARCHIVE_SCHEMA,
};
