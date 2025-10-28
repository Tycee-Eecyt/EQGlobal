'use strict';

const path = require('path');
const { MongoClient } = require('mongodb');
const dotenv = require('dotenv');
const {
  ensureUserIndexes,
  findUserByUsername,
  createUser,
  serializeUser,
  normalizeRoleLevel,
} = require('../backend/auth/userStore');
const { ROLE_LEVELS, getRoleInfo } = require('../backend/auth/roles');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('-')) {
      continue;
    }
    const next = argv[i + 1];
    switch (arg) {
      case '--username':
      case '-u':
        options.username = next;
        i += 1;
        break;
      case '--password':
      case '-p':
        options.password = next;
        i += 1;
        break;
      case '--role':
      case '--role-level':
      case '-r':
        options.role = next;
        i += 1;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        break;
    }
  }
  return options;
}

function printUsage() {
  const roles = Object.values(ROLE_LEVELS)
    .map((level) => {
      const info = getRoleInfo(level);
      return `  ${level} (${info.name}) – ${info.description}`;
    })
    .join('\n');
  console.log(`Usage: node scripts/create-user.js --username <name> --password <pwd> [--role <level>]

Options:
  -u, --username     Username for the account (required)
  -p, --password     Plaintext password for the account (required)
  -r, --role         Role level (1-4). Defaults to ${ROLE_LEVELS.BASE}.
  -h, --help         Show this message

Roles:
${roles}
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const username = (args.username || '').trim();
  const password = args.password;
  const roleLevelInput = args.role !== undefined ? Number(args.role) : ROLE_LEVELS.BASE;
  const roleLevel = normalizeRoleLevel(roleLevelInput);

  if (!username || !password) {
    printUsage();
    console.error('username and password are required.');
    process.exit(1);
  }

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI is not configured in .env');
  }
  const dbName = process.env.MONGODB_DB || 'eqglobal';

  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const db = client.db(dbName);
    await ensureUserIndexes(db);
    const existing = await findUserByUsername(db, username);
    if (existing) {
      console.error(`User "${username}" already exists.`);
      process.exit(1);
    }
    const created = await createUser(db, {
      username,
      password,
      roleLevel,
      createdBy: 'scripts/create-user.js',
    });
    const safe = serializeUser(created);
    const info = getRoleInfo(roleLevel);
    console.log('Created user:', {
      id: safe.id,
      username: safe.username,
      roleLevel: safe.roleLevel,
      roleName: info.name,
    });
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Failed to create user:', err.message || err);
  process.exit(1);
});
