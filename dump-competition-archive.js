const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs-extra');
const { Command } = require('commander');
const { numberToAlphabet } = require('./utils');
const { ARCHIVE_SCHEMA } = require('./competition-archive.schema');

/** @typedef {import('./competition-archive.schema').JsonValue} JsonValue */
/** @typedef {import('./competition-archive.schema').SdutojCompetitionArchive} SdutojCompetitionArchive */
/** @typedef {import('./competition-archive.schema').SdutojArchiveWarning} SdutojArchiveWarning */

const isDev = process.env.NODE_ENV === 'development';
const MAX_MYSQL_POOL_CONNECTION = 2;

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

/**
 * @param {unknown} value
 * @returns {JsonValue}
 */
function toJsonValue(value) {
  if (value === undefined) {
    return null;
  }
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('base64');
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (typeof value === 'object') {
    return toJsonRow(value);
  }
  return String(value);
}

/**
 * @param {object} row
 * @returns {{ [key: string]: JsonValue }}
 */
function toJsonRow(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, toJsonValue(value)]),
  );
}

/**
 * @param {{ [key: string]: JsonValue }} row
 * @param {string} field
 * @param {JsonValue} emptyFallback
 * @param {SdutojArchiveWarning[]} warnings
 * @param {{ table: string, id: number | string | null }} context
 */
function parseInlineJsonField(row, field, emptyFallback, warnings, context) {
  const value = row[field];
  if (value === null || value === '') {
    row[field] = emptyFallback;
    return;
  }
  if (typeof value !== 'string') {
    return;
  }
  try {
    row[field] = JSON.parse(value);
  } catch (e) {
    warnings.push({
      table: context.table,
      id: context.id,
      field,
      message: e.message,
    });
  }
}

/**
 * @param {Record<string, unknown>} row
 * @param {SdutojArchiveWarning[]} warnings
 */
function buildCompetition(row, warnings) {
  const competition = toJsonRow(row);
  parseInlineJsonField(competition, 'sp_config', {}, warnings, {
    table: 'competition',
    id: competition.competition_id || null,
  });
  return competition;
}

/**
 * @param {Record<string, unknown>} row
 */
function buildCompetitionSetting(row) {
  return toJsonRow(row);
}

/**
 * @param {Record<string, unknown>} row
 * @param {SdutojArchiveWarning[]} warnings
 */
function buildParticipant(row, warnings) {
  const participant = toJsonRow(row);
  parseInlineJsonField(participant, 'info', {}, warnings, {
    table: 'competition_user',
    id: participant.user_id || null,
  });
  return participant;
}

/**
 * @param {Record<string, unknown>} row
 */
function buildProblem(row) {
  const problem = toJsonRow(row);
  if (!problem.alias && problem.index !== undefined && problem.index !== null) {
    problem.alias = numberToAlphabet(problem.index);
  }
  return problem;
}

/**
 * @param {Record<string, unknown>} row
 * @param {SdutojArchiveWarning[]} warnings
 */
function buildEvent(row, warnings) {
  const event = toJsonRow(row);
  parseInlineJsonField(event, 'detail', {}, warnings, {
    table: 'competition_event',
    id: event.competition_event_id || null,
  });
  return event;
}

/**
 * @param {number} competitionId
 * @returns {Promise<SdutojCompetitionArchive>}
 */
async function buildArchive(competitionId) {
  const warnings = [];
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
      "SELECT * FROM competition_event WHERE competition_id=? AND event LIKE 'solution:%' ORDER BY competition_event_id ASC",
      [competitionId],
    ),
  ]);

  if (!competitionRows.length || !settingRows.length) {
    throw new Error('competition not found');
  }

  const participants = participantRows.map((row) => buildParticipant(row, warnings));
  const problems = problemRows.map(buildProblem);
  const events = eventRows.map((row) => buildEvent(row, warnings));

  return {
    schema: ARCHIVE_SCHEMA,
    dumped_at: new Date().toISOString(),
    competition_id: competitionId,
    competition: buildCompetition(competitionRows[0], warnings),
    competition_setting: buildCompetitionSetting(settingRows[0]),
    participants,
    problems,
    events,
    counts: {
      participants: participants.length,
      problems: problems.length,
      events: events.length,
    },
    warnings,
  };
}

/**
 * @param {string} outputFile
 * @param {SdutojCompetitionArchive} archive
 */
async function writeArchive(outputFile, archive) {
  await fs.ensureDir(path.dirname(outputFile));
  await fs.writeJSON(outputFile, archive, { spaces: 2 });
}

async function main() {
  const program = new Command();
  program
    .name('dump-competition-archive.js')
    .description('Dump raw SDUTOJ contest data and solution events to a JSON archive')
    .version('1.0.0')
    .arguments('<competitionId> <outputFile>')
    .action((competitionIdArg, outputFileArg) => {
      program.competitionId = Number(competitionIdArg);
      program.outputFile = outputFileArg;
    })
    .parse(process.argv);

  const competitionId = program.competitionId;
  const outputFile = program.outputFile;
  if (!Number.isInteger(competitionId) || competitionId <= 0 || !outputFile) {
    program.outputHelp({ error: true });
    process.exit(1);
  }

  await initDb();
  try {
    const archive = await buildArchive(competitionId);
    await writeArchive(outputFile, archive);
    console.log(
      `dumped competition ${competitionId} archive to ${outputFile}: participants=${archive.counts.participants}, problems=${archive.counts.problems}, events=${archive.counts.events}, warnings=${archive.warnings.length}`,
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
  buildArchive,
  writeArchive,
};
