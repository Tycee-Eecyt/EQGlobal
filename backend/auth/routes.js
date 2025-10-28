const express = require('express');
const createAuthMiddleware = require('./middleware');
const {
  ensureUserIndexes,
  findUserByUsername,
  findUserById,
  createUser,
  serializeUser,
} = require('./userStore');
const { issueTokenPair, verifyRefreshToken } = require('./tokens');
const { ROLE_LEVELS, getRoleInfo } = require('./roles');

function createAuthRouter({ passport, getDb, middleware }) {
  if (!passport) {
    throw new Error('passport instance is required');
  }
  if (typeof getDb !== 'function') {
    throw new Error('getDb function is required');
  }

  const router = express.Router();
  const authMiddleware = middleware || createAuthMiddleware({ passport });
  const { authenticateJwt, requireRoleAtMost } = authMiddleware;

  let indexesEnsured = false;
  async function ensureIndexes() {
    if (indexesEnsured) {
      return;
    }
    const db = await getDb();
    await ensureUserIndexes(db);
    indexesEnsured = true;
  }

  ensureIndexes().catch((err) => {
    console.warn('Failed to ensure user indexes on startup:', err.message);
  });

  router.post('/login', async (req, res, next) => {
    await ensureIndexes();
    passport.authenticate('local', { session: false }, async (err, user, info) => {
      if (err) {
        return next(err);
      }
      if (!user) {
        return res.status(401).json({ error: info?.message || 'Invalid credentials.' });
      }
      const tokens = issueTokenPair(user);
      return res.json({
        user: serializeUser(user),
        ...tokens,
      });
    })(req, res, next);
  });

  router.post('/refresh', async (req, res) => {
    await ensureIndexes();
    try {
      const { refreshToken } = req.body || {};
      if (!refreshToken) {
        return res.status(400).json({ error: 'refreshToken is required' });
      }
      const decoded = verifyRefreshToken(refreshToken);
      const db = await getDb();
      const user = await findUserById(db, decoded.sub);
      if (!user) {
        return res.status(401).json({ error: 'Invalid refresh token' });
      }
      const tokens = issueTokenPair(user);
      return res.json({
        user: serializeUser(user),
        ...tokens,
      });
    } catch (err) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
  });

  router.get('/me', authenticateJwt, async (req, res) => {
    await ensureIndexes();
    const safeUser = serializeUser(req.user);
    res.json({ user: safeUser });
  });

  router.post(
    '/users',
    authenticateJwt,
    requireRoleAtMost(ROLE_LEVELS.ADMIN),
    async (req, res) => {
      await ensureIndexes();
      const { username, password, roleLevel } = req.body || {};
      if (!username || !password) {
        return res.status(400).json({ error: 'username and password are required' });
      }
      try {
        const db = await getDb();
        const existing = await findUserByUsername(db, username);
        if (existing) {
          return res.status(409).json({ error: 'Username already exists.' });
        }
        const created = await createUser(db, {
          username,
          password,
          roleLevel,
          createdBy: req.authUser?.id || null,
        });
        res.status(201).json({ user: serializeUser(created) });
      } catch (err) {
        console.error('Failed to create user', err);
        res.status(500).json({ error: 'Failed to create user.' });
      }
    }
  );

  router.get(
    '/users',
    authenticateJwt,
    requireRoleAtMost(ROLE_LEVELS.ADMIN),
    async (req, res) => {
      await ensureIndexes();
      try {
        const db = await getDb();
        const collection = db.collection('users');
        const users = await collection
          .find({}, { projection: { passwordHash: 0, normalizedUsername: 0 } })
          .sort({ roleLevel: 1, username: 1 })
          .toArray();
        res.json({
          users: users.map((user) => serializeUser(user)),
        });
      } catch (err) {
        console.error('Failed to list users', err);
        res.status(500).json({ error: 'Failed to list users.' });
      }
    }
  );

  router.get('/roles', (req, res) => {
    res.json({
      roles: Object.values(ROLE_LEVELS).map((level) => getRoleInfo(level)),
    });
  });

  return router;
}

module.exports = createAuthRouter;
