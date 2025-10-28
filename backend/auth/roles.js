const ROLE_LEVELS = Object.freeze({
  ADMIN: 1,
  OFFICER: 2,
  TRACKER: 3,
  BASE: 4,
});

const ROLE_NAMES = Object.freeze({
  [ROLE_LEVELS.ADMIN]: 'admin',
  [ROLE_LEVELS.OFFICER]: 'officer',
  [ROLE_LEVELS.TRACKER]: 'tracker',
  [ROLE_LEVELS.BASE]: 'base',
});

const ROLE_DESCRIPTIONS = Object.freeze({
  [ROLE_LEVELS.ADMIN]: 'Full access, including admin configuration screens.',
  [ROLE_LEVELS.OFFICER]: 'Operational access except admin configuration.',
  [ROLE_LEVELS.TRACKER]: 'Operational access except admin configuration.',
  [ROLE_LEVELS.BASE]: 'Use local GINA triggers only.',
});

function normalizeRoleLevel(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return ROLE_LEVELS.BASE;
  }
  const level = Math.floor(parsed);
  if (level < ROLE_LEVELS.ADMIN || level > ROLE_LEVELS.BASE) {
    return ROLE_LEVELS.BASE;
  }
  return level;
}

function getRoleName(level) {
  return ROLE_NAMES[normalizeRoleLevel(level)];
}

function getRoleDescription(level) {
  return ROLE_DESCRIPTIONS[normalizeRoleLevel(level)];
}

function getRoleInfo(level) {
  const normalized = normalizeRoleLevel(level);
  return {
    level: normalized,
    name: getRoleName(normalized),
    description: getRoleDescription(normalized),
  };
}

function isRoleAtMost(roleLevel, maxLevel) {
  const normalizedRole = normalizeRoleLevel(roleLevel);
  const normalizedMax = normalizeRoleLevel(maxLevel);
  return normalizedRole <= normalizedMax;
}

module.exports = {
  ROLE_LEVELS,
  ROLE_NAMES,
  normalizeRoleLevel,
  getRoleName,
  getRoleDescription,
  getRoleInfo,
  isRoleAtMost,
};
