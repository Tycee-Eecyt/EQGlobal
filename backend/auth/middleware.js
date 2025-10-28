const { isRoleAtMost, getRoleInfo } = require('./roles');
const { serializeUser } = require('./userStore');

function createAuthMiddleware({ passport }) {
  if (!passport) {
    throw new Error('passport instance is required for auth middleware');
  }

  function authenticateJwt(req, res, next) {
    passport.authenticate('jwt', { session: false }, (err, user, info) => {
      if (err) {
        return next(err);
      }
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      req.user = user;
      req.authUser = serializeUser(user);
      req.authInfo = info;
      return next();
    })(req, res, next);
  }

  function optionalAuthenticateJwt(req, res, next) {
    passport.authenticate('jwt', { session: false }, (err, user, info) => {
      if (err) {
        return next(err);
      }
      if (user) {
        req.user = user;
        req.authUser = serializeUser(user);
        req.authInfo = info;
      }
      return next();
    })(req, res, next);
  }

  function requireRoleAtMost(maxRoleLevel) {
    return (req, res, next) => {
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (!isRoleAtMost(req.user.roleLevel, maxRoleLevel)) {
        const info = getRoleInfo(req.user.roleLevel);
        return res.status(403).json({
          error: 'Forbidden',
          role: info.name,
        });
      }
      return next();
    };
  }

  return {
    authenticateJwt,
    optionalAuthenticateJwt,
    requireRoleAtMost,
  };
}

module.exports = createAuthMiddleware;
