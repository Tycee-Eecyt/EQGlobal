EQGlobal TODOs

- Overlay polish options
  - Style toggle: Classic (yellow time + red bar) vs Modern (pill + vertical progress)
  - Expiry cues: Blink or pulse bar/text in last 3s; optional sound hook
  - Per-category colors: Map categories to colors in overlay (AoEs, Heals, Cures, etc.) with toggle
  - Compact mode: Reduced height rows to fit more timers; optional max visible count
  - Smooth animation: Optional requestAnimationFrame-driven progress for 60fps visuals

- Trigger management
  - Category editor: Dropdown with suggestions and quick-add custom categories
  - Import UX: Progress + success/error toast; allow merging/import preview before replacing
  - Export UX: Include metadata (exported at, app version)

- Regex compatibility
  - Extend .NET→JS translator: handle conditional groups (?(name)yes|no) with best-effort rewrites
  - Add pattern unit tests for tricky imports (death touches, CH/RCH, slow chains)

- Backend and settings
  - Optional debounce for backend flush under heavy trigger volume
  - Settings toggle for overlay style and category colors

- Timer behavior
  - Keep emitting UI updates every tick (fixed): ensure smooth countdowns even without new triggers
  - Optional global tick rate setting (250–1000ms)

- Data minimization & role-based access
  - Only send select commands (e.g., `!tod` / `tod`) to the backend; keep constant local scanning for regular GINA triggers.
  - Add per-trigger option to "Share to backend" so only chosen triggers post events to DB.
  - Provide an Admin tab to manage global GINA-like triggers (create/edit shared triggers) — admin-only.
  - Roles: `admin` (manage global triggers, can submit updates), `officer` (can submit `!tod`/`tod` updates), `viewer` (read-only: view windows).
  - Protect write APIs: `POST /api/log-lines`, `POST /api/log-events` (officer/admin), `POST /api/global-triggers` (admin), while allowing public reads where appropriate.
  - Persist auth in the app and include Bearer token on backend requests.
  - Evaluate auth stack: Passport.js vs lightweight JWT/HMAC; document choice and flows.

