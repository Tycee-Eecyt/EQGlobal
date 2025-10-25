const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const path = require('path');

require('dotenv').config({
  path: path.resolve(process.cwd(), '.env'),
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

const port = process.env.PORT || 4000;
const mongoUri = process.env.MONGODB_URI;
const mongoDbName = process.env.MONGODB_DB || 'eqglobal';

let mongoClient;
let mongoDb;

async function ensureMongoConnection() {
  if (mongoDb && mongoClient) {
    return mongoDb;
  }

  if (!mongoUri) {
    throw new Error('MONGODB_URI is not configured. Check your .env file.');
  }

  mongoClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
  await mongoClient.connect();
  mongoDb = mongoClient.db(mongoDbName);
  console.log(`Connected to MongoDB Atlas database "${mongoDbName}"`);
  return mongoDb;
}

app.get('/health', async (_req, res) => {
  try {
    await ensureMongoConnection();
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(503).json({ status: 'error', message: error.message });
  }
});

app.post('/api/log-lines', async (req, res) => {
  const { lines } = req.body || {};
  if (!Array.isArray(lines)) {
    return res.status(400).json({ error: 'Expected "lines" to be an array.' });
  }

  try {
    const db = await ensureMongoConnection();
    const collection = db.collection('log_lines');
    const documents = lines
      .map((entry) => ({
        filePath: entry.filePath || '',
        line: entry.line || '',
        timestamp: entry.timestamp ? new Date(entry.timestamp) : new Date(),
        ingestedAt: new Date(),
      }))
      .filter((doc) => doc.line);

    if (documents.length === 0) {
      return res.json({ inserted: 0 });
    }

    const result = await collection.insertMany(documents, { ordered: false });
    res.json({ inserted: result.insertedCount || documents.length });
  } catch (error) {
    console.error('Failed to persist log lines', error);
    res.status(500).json({ error: 'Failed to persist log lines.' });
  }
});

app.post('/api/log-events', async (req, res) => {
  const { events } = req.body || {};
  if (!Array.isArray(events)) {
    return res.status(400).json({ error: 'Expected "events" to be an array.' });
  }

  try {
    const db = await ensureMongoConnection();
    const collection = db.collection('log_events');
    const documents = events
      .map((event) => ({
        triggerId: event.triggerId || null,
        label: event.label || '',
        duration: event.duration || 0,
        color: event.color || '#00c9ff',
        filePath: event.filePath || '',
        line: event.line || '',
        timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
        timer: event.timer || null,
        ingestedAt: new Date(),
      }))
      .filter((doc) => doc.label);

    if (documents.length === 0) {
      return res.json({ inserted: 0 });
    }

    const result = await collection.insertMany(documents, { ordered: false });
    res.json({ inserted: result.insertedCount || documents.length });
  } catch (error) {
    console.error('Failed to persist log events', error);
    res.status(500).json({ error: 'Failed to persist log events.' });
  }
});

app.get('/api/mob-windows', async (_req, res) => {
  try {
    const db = await ensureMongoConnection();
    const collection = db.collection('mob_windows');
    const doc = await collection.findOne({ _id: 'global' });
    if (!doc) {
      return res.json({ kills: {}, updatedAt: null });
    }
    res.json({
      kills: doc.kills || {},
      updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : null,
    });
  } catch (error) {
    console.error('Failed to load mob window state', error);
    res.status(500).json({ error: 'Failed to load mob window state.' });
  }
});

app.post('/api/mob-windows', async (req, res) => {
  const { kills } = req.body || {};
  if (!kills || typeof kills !== 'object') {
    return res.status(400).json({ error: 'Expected "kills" to be an object.' });
  }

  const sanitized = {};
  for (const [mobId, timestamp] of Object.entries(kills)) {
    if (typeof mobId !== 'string' || !mobId.trim()) {
      continue;
    }
    const iso = typeof timestamp === 'string' ? timestamp : new Date(timestamp).toISOString();
    if (!iso || Number.isNaN(Date.parse(iso))) {
      continue;
    }
    sanitized[mobId] = new Date(iso).toISOString();
  }

  try {
    const db = await ensureMongoConnection();
    const collection = db.collection('mob_windows');
    const updatedAt = new Date();
    await collection.updateOne(
      { _id: 'global' },
      { $set: { kills: sanitized, updatedAt } },
      { upsert: true }
    );
    res.json({ kills: sanitized, updatedAt: updatedAt.toISOString() });
  } catch (error) {
    console.error('Failed to persist mob window state', error);
    res.status(500).json({ error: 'Failed to persist mob window state.' });
  }
});

app.listen(port, async () => {
  console.log(`EQGlobal backend listening on http://localhost:${port}`);
  if (!mongoUri) {
    console.warn('MONGODB_URI is not set. Log data will not be persisted until configured.');
  } else {
    try {
      await ensureMongoConnection();
    } catch (error) {
      console.error('Unable to connect to MongoDB on startup:', error.message);
    }
  }
});

process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  try {
    if (mongoClient) {
      await mongoClient.close();
    }
  } finally {
    process.exit(0);
  }
});
