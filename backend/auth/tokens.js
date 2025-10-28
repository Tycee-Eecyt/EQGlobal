const jwt = require('jsonwebtoken');
const { getRoleInfo } = require('./roles');

function getAccessSecret() {
  const secret = process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }
  return secret;
}

function getRefreshSecret() {
  const secret = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_REFRESH_SECRET is not configured');
  }
  return secret;
}

function getIssuer() {
  return process.env.JWT_ISSUER || 'eqglobal';
}

function getAudience() {
  return process.env.JWT_AUDIENCE || 'eqglobal-clients';
}

function getAccessTtl() {
  return process.env.JWT_ACCESS_TTL || process.env.JWT_EXPIRES_IN || '1h';
}

function getRefreshTtl() {
  return process.env.JWT_REFRESH_TTL || '30d';
}

function buildTokenPayload(user, type) {
  const info = getRoleInfo(user.roleLevel);
  return {
    sub: user._id ? String(user._id) : undefined,
    username: user.username,
    roleLevel: info.level,
    roleName: info.name,
    type,
  };
}

function decodeExpiration(token) {
  const decoded = jwt.decode(token);
  if (!decoded || !decoded.exp) {
    return null;
  }
  return new Date(decoded.exp * 1000).toISOString();
}

function signToken(user, { type, secret, expiresIn }) {
  const payload = buildTokenPayload(user, type);
  const token = jwt.sign(payload, secret, {
    expiresIn,
    issuer: getIssuer(),
    audience: getAudience(),
  });
  return {
    token,
    payload,
    expiresAt: decodeExpiration(token),
  };
}

function signAccessToken(user) {
  return signToken(user, {
    type: 'access',
    secret: getAccessSecret(),
    expiresIn: getAccessTtl(),
  });
}

function signRefreshToken(user) {
  return signToken(user, {
    type: 'refresh',
    secret: getRefreshSecret(),
    expiresIn: getRefreshTtl(),
  });
}

function issueTokenPair(user) {
  const access = signAccessToken(user);
  const refresh = signRefreshToken(user);
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken: refresh.token,
    refreshTokenExpiresAt: refresh.expiresAt,
  };
}

function verifyRefreshToken(token) {
  if (!token) {
    throw new Error('Refresh token is required');
  }
  const decoded = jwt.verify(token, getRefreshSecret(), {
    issuer: getIssuer(),
    audience: getAudience(),
  });
  if (!decoded || decoded.type !== 'refresh') {
    throw new Error('Invalid refresh token');
  }
  return decoded;
}

module.exports = {
  getAccessSecret,
  getRefreshSecret,
  getAudience,
  getIssuer,
  getAccessTtl,
  getRefreshTtl,
  signAccessToken,
  signRefreshToken,
  issueTokenPair,
  verifyRefreshToken,
};
