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

const DURATION_UNIT_SECONDS = {
  s: 1,
  min: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
};

function normalizeRanklandTitle(title, label = 'contest.title') {
  if (typeof title === 'string') {
    return { fallback: title };
  }
  if (title && typeof title === 'object' && !Array.isArray(title)) {
    return title;
  }
  throw new Error(`${label} must be a string or i18n object`);
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
  if (!Number.isSafeInteger(seconds)) {
    throw new Error(`${label} must convert exactly to an integer number of seconds`);
  }
  return [seconds, 's'];
}

function buildRanklandContestFields(contest, label = 'contest') {
  if (!contest || typeof contest !== 'object' || Array.isArray(contest)) {
    throw new Error(`${label} must be a JSON object`);
  }

  const fields = {};
  for (const field of RANKLAND_CONTEST_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(contest, field)) {
      if (NULLABLE_RANKLAND_CONTEST_FIELDS.has(field)) {
        fields[field] = null;
      }
      continue;
    }
    if (field === 'title') {
      fields.title = normalizeRanklandTitle(contest.title, `${label}.title`);
    } else if (field === 'duration') {
      fields.duration = normalizeRanklandTimeDuration(contest.duration, `${label}.duration`);
    } else if (field === 'frozenDuration') {
      fields.frozenDuration = contest.frozenDuration === null || contest.frozenDuration === undefined
        ? null
        : normalizeRanklandTimeDuration(contest.frozenDuration, `${label}.frozenDuration`);
    } else if (
      NULLABLE_RANKLAND_CONTEST_FIELDS.has(field) &&
      (contest[field] === null || contest[field] === undefined)
    ) {
      fields[field] = null;
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
  const { contest, ...rest } = payload;
  return {
    ...rest,
    ...buildRanklandContestFields(contest, `${label}.contest`),
  };
}

module.exports = {
  RANKLAND_CONTEST_FIELDS,
  buildRanklandContestFields,
  flattenRanklandContestPayload,
  normalizeRanklandTimeDuration,
  normalizeRanklandTitle,
};
