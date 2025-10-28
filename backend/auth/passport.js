const { Strategy: LocalStrategy } = require('passport-local');
const { Strategy: JwtStrategy, ExtractJwt } = require('passport-jwt');
const {
  findUserByUsername,
  findUserById,
  verifyPassword,
  touchLogin,
  serializeUser,
} = require('./userStore');
const {
  getAccessSecret,
  getAudience,
  getIssuer,
} = require('./tokens');

function configurePassport({ passport, getDb }) {
  if (!passport) {
    throw new Error('passport instance is required');
  }
  if (typeof getDb !== 'function') {
    throw new Error('getDb function is required');
  }

  passport.use(
    new LocalStrategy(
      {
        usernameField: 'username',
        passwordField: 'password',
        session: false,
      },
      async (username, password, done) => {
        try {
          const db = await getDb();
          const user = await findUserByUsername(db, username);
          if (!user) {
            return done(null, false, { message: 'Invalid credentials.' });
          }
          const match = await verifyPassword(user, password);
          if (!match) {
            return done(null, false, { message: 'Invalid credentials.' });
          }
          await touchLogin(db, user._id);
          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    )
  );

  passport.use(
    new JwtStrategy(
      {
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        secretOrKey: getAccessSecret(),
        issuer: getIssuer(),
        audience: getAudience(),
      },
      async (payload, done) => {
        try {
          if (!payload || payload.type !== 'access' || !payload.sub) {
            return done(null, false);
          }
          const db = await getDb();
          const user = await findUserById(db, payload.sub);
          if (!user) {
            return done(null, false);
          }
          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    )
  );

  passport.serializeUser((user, done) => {
    done(null, user && user._id ? String(user._id) : null);
  });

  passport.deserializeUser(async (id, done) => {
    try {
      const db = await getDb();
      const user = await findUserById(db, id);
      done(null, user ? serializeUser(user) : false);
    } catch (err) {
      done(err);
    }
  });
}

module.exports = configurePassport;
