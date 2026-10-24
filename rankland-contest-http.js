const RANKLAND_CONTEST_FIELDS = [
  'title',
  'startAt',
  'duration',
  'frozenDuration',
  'banner',
  'refLinks',
];
const NULLABLE_RANKLAND_CONTEST_FIELDS = new Set([
  'frozenDuration',
  'banner',
  'refLinks',
]);
// Only these SRK-level fields are part of the API v2 contest write contract.
const RANKLAND_CONTEST_CONFIG_FIELDS = [
  'uk',
  'name',
  'problems',
  'users',
  'markers',
  'series',
  'sorter',
  'contributors',
  'redirectUK',
  'srkFileID',
];
const MAX_CONTEST_DURATION_SECONDS = 0xffffffff;

const DURATION_UNIT_SECONDS = {
  s: 1,
  min: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
};

function normalizeRanklandTitle(title, label = 'contest.title') {
  if (typeof title === 'string') {
    title = { fallback: title };
  }
  if (
    title && typeof title === 'object' && !Array.isArray(title) &&
    typeof title.fallback === 'string' && title.fallback.trim().length > 0 &&
    Object.values(title).every((value) => typeof value === 'string')
  ) {
    return title;
  }
  throw new Error(`${label} must be a non-empty string or i18n object with a non-empty fallback and string values`);
}

function normalizeRanklandTimeDuration(duration, label = 'contest duration') {
  if (!Array.isArray(duration) || duration.length !== 2) {
    throw new Error(`${label} must be a [value, unit] tuple`);
  }
  const [value, unit] = duration;
  const multiplier = DURATION_UNIT_SECONDS[unit];
  if (multiplier === undefined) {
    throw new Error(`${label} unit must be one of s, min, h, d; received ${String(unit)}`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} value must be a non-negative finite number`);
  }
  const seconds = value * multiplier;
  if (!Number.isSafeInteger(seconds) || seconds > MAX_CONTEST_DURATION_SECONDS) {
    throw new Error(`${label} must convert exactly to an integer number of seconds in 0..${MAX_CONTEST_DURATION_SECONDS}`);
  }
  return [seconds, 's'];
}

function buildRanklandContestFields(contest, label = 'contest') {
  if (!contest || typeof contest !== 'object' || Array.isArray(contest)) {
    throw new Error(`${label} must be a JSON object`);
  }

  const fields = {};
  for (const field of RANKLAND_CONTEST_FIELDS) {
    // PATCH treats omission as "keep existing" and explicit null as "clear".
    if (!Object.prototype.hasOwnProperty.call(contest, field) || contest[field] === undefined) {
      continue;
    }
    if (NULLABLE_RANKLAND_CONTEST_FIELDS.has(field) && contest[field] === null) {
      fields[field] = null;
      continue;
    }
    if (field === 'title') {
      fields.title = normalizeRanklandTitle(contest.title, `${label}.title`);
    } else if (field === 'duration') {
      fields.duration = normalizeRanklandTimeDuration(contest.duration, `${label}.duration`);
    } else if (field === 'frozenDuration') {
      fields.frozenDuration = normalizeRanklandTimeDuration(contest.frozenDuration, `${label}.frozenDuration`);
    } else {
      fields[field] = contest[field];
    }
  }
  return fields;
}

function flattenRanklandContestPayload(payload, label = 'payload') {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const fields = {};
  for (const field of RANKLAND_CONTEST_CONFIG_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field) && payload[field] !== undefined) {
      fields[field] = payload[field];
    }
  }
  return {
    ...fields,
    ...buildRanklandContestFields(payload.contest, `${label}.contest`),
  };
}

function buildRanklandContestCreatePayload(payload, label = 'payload') {
  const fields = flattenRanklandContestPayload(payload, label);
  // srkFileID is only writable after the contest has been created.
  delete fields.srkFileID;
  for (const field of ['problems', 'users', 'markers', 'series']) {
    if (fields[field] === undefined) {
      fields[field] = [];
    }
  }
  return fields;
}

function buildRanklandContestUpdatePayload(payload, label = 'payload') {
  const fields = flattenRanklandContestPayload(payload, label);
  // The contest UK is supplied by the route, not the PATCH body.
  delete fields.uk;
  return fields;
}

module.exports = {
  RANKLAND_CONTEST_FIELDS,
  buildRanklandContestCreatePayload,
  buildRanklandContestUpdatePayload,
  buildRanklandContestFields,
  flattenRanklandContestPayload,
  normalizeRanklandTimeDuration,
  normalizeRanklandTitle,
};
