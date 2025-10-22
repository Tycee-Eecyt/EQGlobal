# EQGlobal Log Timer Overlay

Electron-based overlay that watches EverQuest log files, surfaces configurable timers similar to Gina, and forwards log data to a MongoDB Atlas–backed backend service.

## Prerequisites

- Node.js 18+ and npm
- MongoDB Atlas connection string (for the backend)
- EverQuest log directory accessible from this machine

## Initial Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and adjust values:
   ```bash
   cp .env.example .env
   ```
   - `EQ_LOG_DIR` – default log directory to load when the app first launches.
   - `BACKEND_URL` – base URL for the backend service (e.g. `http://localhost:4000`).
   - `MONGODB_URI` / `MONGODB_DB` – Atlas credentials for the backend.

## Running the Apps

- Start only the Electron overlay:
  ```bash
  npm run dev
  ```
- Start the backend service:
  ```bash
  npm run backend
  ```
- Run both together:
  ```bash
  npm start
  ```

## Electron Overlay Highlights

- Watches EverQuest log files (`*.log` and `eqlog_*.txt`) inside the configured `Logs` directory.
- Detects trigger phrases (plain text or regex) and tracks countdown timers.
- Transparent overlay stays on top; optionally allows clicks to pass through to the game.
- Control panel lists active timers, shows recent log lines, and manages triggers.
- Forwards raw log lines and trigger events to the backend in small batches.

### Configuring Triggers

Use the **Triggers** section in the control panel to add or edit entries. Each trigger supports:

- `Label` – display name in the overlay.
- `Pattern` – plain text match or regex (enable **Use Regex**).
- `Duration` – timer length in seconds.
- `Color` – tint for the overlay pill.

Click **Reset Defaults** to reload the sample trigger set from `src/shared/defaultTriggers.json`.

## Backend Service

`backend/server.js` exposes:

- `GET /health` – health probe, ensures MongoDB connectivity.
- `POST /api/log-lines` – accepts `{ lines: [{ filePath, line, timestamp }] }`.
- `POST /api/log-events` – accepts `{ events: [{ triggerId, label, duration, ... }] }`.

Data is stored in `log_lines` and `log_events` collections. Set `MONGODB_URI` before running or the server logs a warning and skips persistence.

## Overlay Tips

- **Overlay opacity** slider adjusts transparency live.
- Enable **Allow game clicks through overlay** to make the window click-through while keeping timers visible.
- Press **Focus Overlay** if the overlay window gets hidden behind other apps.

## Next Steps

- Expand trigger configuration UI (import/export, categories).
- Add notification sounds or text-to-speech.
- Build visualization or analytics pages on top of the stored MongoDB data.
