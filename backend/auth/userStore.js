const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');
const { normalizeRoleLevel, getRoleInfo } = require('./roles');

const USERS_COLLECTION = 'users';
const USERNAME_INDEX_NAME = 'uniq_users_normalized_username';

function normalizeUsername(username) {
  return String(username || '')
    .trim()
    .toLowerCase();
}

function getUsersCollection(db) {
  if (!db) {
    throw new Error('Database reference is required');
  }
  return db.collection(USERS_COLLECTION);
}

async function ensureUserIndexes(db) {
  const collection = getUsersCollection(db);
  await collection.createIndex(
    { normalizedUsername: 1 },
    { unique: true, name: USERNAME_INDEX_NAME, background: true }
  );
}

async function hashPassword(password) {
  const pwd = String(password || '');
  if (!pwd) {
    throw new Error('Password is required');
  }
  return bcrypt.hash(pwd, 12);
}

async function createUser(db, { username, password, roleLevel = 4, createdBy = null } = {}) {
  if (!username) {
    throw new Error('Username is required');
  }
  const normalizedUsername = normalizeUsername(username);
  const passwordHash = await hashPassword(password);
  const role = normalizeRoleLevel(roleLevel);
  const now = new Date();

  const payload = {
    username: String(username).trim(),
    normalizedUsername,
    passwordHash,
    roleLevel: role,
    createdAt: now,
    updatedAt: now,
    createdBy: createdBy ? String(createdBy) : null,
    updatedBy: createdBy ? String(createdBy) : null,
    lastLoginAt: null,
  };

  const collection = getUsersCollection(db);
  const result = await collection.insertOne(payload);
  return {
    ...payload,
    _id: result.insertedId,
  };
}

async function findUserByUsername(db, username) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) {
    return null;
  }
  const collection = getUsersCollection(db);
  return collection.findOne({ normalizedUsername });
}

async function findUserById(db, id) {
  if (!id) {
    return null;
  }
  let objectId = null;
  try {
    objectId = typeof id === 'string' ? new ObjectId(id) : id;
  } catch (_err) {
    return null;
  }
  const collection = getUsersCollection(db);
  return collection.findOne({ _id: objectId });
}

async function updateUserRole(db, id, nextRoleLevel, updatedBy = null) {
  const roleLevel = normalizeRoleLevel(nextRoleLevel);
  const collection = getUsersCollection(db);
  await collection.updateOne(
    { _id: typeof id === 'string' ? new ObjectId(id) : id },
    {
      $set: {
        roleLevel,
        updatedAt: new Date(),
        updatedBy: updatedBy ? String(updatedBy) : null,
      },
    }
  );
  return findUserById(db, id);
}

async function updateUserPassword(db, id, nextPassword, updatedBy = null) {
  const passwordHash = await hashPassword(nextPassword);
  const collection = getUsersCollection(db);
  await collection.updateOne(
    { _id: typeof id === 'string' ? new ObjectId(id) : id },
    {
      $set: {
        passwordHash,
        updatedAt: new Date(),
        updatedBy: updatedBy ? String(updatedBy) : null,
      },
    }
  );
  return findUserById(db, id);
}

async function verifyPassword(user, candidatePassword) {
  if (!user || !user.passwordHash) {
    return false;
  }
  return bcrypt.compare(String(candidatePassword || ''), user.passwordHash);
}

async function touchLogin(db, id, ipAddress = null) {
  const collection = getUsersCollection(db);
  await collection.updateOne(
    { _id: typeof id === 'string' ? new ObjectId(id) : id },
    {
      $set: {
        lastLoginAt: new Date(),
        lastLoginIp: ipAddress ? String(ipAddress) : null,
      },
    }
  );
}

function serializeUser(user) {
  if (!user) {
    return null;
  }
  const info = getRoleInfo(user.roleLevel);
  return {
    id: user._id ? String(user._id) : undefined,
    username: user.username,
    roleLevel: info.level,
    roleName: info.name,
    roleDescription: info.description,
    createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : null,
    updatedAt: user.updatedAt ? new Date(user.updatedAt).toISOString() : null,
    lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : null,
  };
}

module.exports = {
  USERS_COLLECTION,
  ensureUserIndexes,
  createUser,
  findUserByUsername,
  findUserById,
  updateUserRole,
  updateUserPassword,
  verifyPassword,
  touchLogin,
  serializeUser,
  normalizeRoleLevel,
};
