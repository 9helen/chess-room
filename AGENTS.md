# Chess Room project guide

## Project overview

Chess Room is a small browser chess application inspired by chess platforms such as chess.com. It currently supports a profile dashboard, friend games, games against a built-in computer opponent, tactical puzzles, a practice board, and a player leaderboard. Keep changes focused on this MVP and follow the existing lightweight architecture.

## Tech stack

- **Runtime:** Node.js 14 or newer.
- **Server:** CommonJS JavaScript using Node's built-in `http`, `fs`, and `path` modules.
- **Browser UI:** Plain HTML, CSS, and JavaScript; no frontend framework or build step.
- **Chess rules:** `chess.js` 0.10.3.
- **Realtime play:** `ws` WebSocket server.
- **Persistence:** SQLite through `sqlite3` 5.1.7-compatible API.
- **Tests:** Node.js smoke test in `test/smoke.js`.

`package.json` and `package-lock.json` are the source of truth for scripts and dependency versions. Keep the lockfile in sync when dependencies change.

## Run locally

From the repository root:

```sh
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). The server uses port `3000` by default. Set `PORT` to use another port and `CHESS_DB_PATH` to select another SQLite database location. On first run, the database is created at `data/chess.sqlite`.

Run the existing smoke suite with:

```sh
npm test
```

Do not start a long-running development server unless the user asks; the app is a plain Node server and is not needed to edit its source.

## Repository map

- `server.js` — HTTP API, static file serving, WebSocket rooms, chess validation, ratings, and SQLite schema/migrations.
- `public/index.html` — Main single-page app markup and its views.
- `public/style.css` — App layout, components, and responsive styles.
- `public/app.js` — Client navigation, board rendering, profile/stats, bot, puzzle, practice, and WebSocket behavior.
- `public/flowstate-bg.js` — Animated background effect used by the main app.
- `test/smoke.js` — Integration-style smoke coverage for API, chess, persistence, puzzles, and multiplayer.
- `flowstate/index.html` — Standalone visual prototype/reference page. The current server serves files from `public/`, so this folder is not part of the main app's route tree unless serving is deliberately changed.
- `README.md` — User-facing setup and feature summary.

## Features currently set up

- **Profile dashboard:** Username-based profiles show friend-game rating and record, computer results, puzzle progress/accuracy, and a leaderboard.
- **Friend games:** Create or join invite rooms by code. WebSockets carry live game state. Controls are Rapid (10 minutes), Blitz (3 minutes), and untimed. Friend games update Elo and game records.
- **Computer games:** Play an approachable built-in opponent. Results are recorded separately and do not change Elo.
- **Puzzles:** Solve a small set of tactical positions. Attempts and solves are stored separately from game ratings.
- **Practice board:** Move pieces freely to explore a position without affecting a profile rating.
- **Local identity:** A profile is selected by username. There is no password, sign-in, or account recovery system; usernames are public identifiers.

## Architecture and implementation conventions

- Keep the frontend dependency-free and compatible with the current static serving model. Do not add a bundler or framework unless the user asks for an architectural change.
- Keep browser code in `public/` and server code in `server.js`, unless a change clearly warrants a small existing-style module extraction.
- Use the existing JSON API pattern for request/response operations. Current endpoints include `/api/profile`, `/api/leaderboard`, `/api/bot-move`, `/api/legal-moves`, `/api/local-move`, `/api/solo-result`, and `/api/puzzle-result`.
- Friend-game WebSocket messages currently include `join`, `move`, `resign`, and `leave`; server events include `joined`, `state`, `opponent-left`, and `error`. Preserve server-side validation of player identity, turns, legal moves, and clocks.
- Use `chess.js` for chess legality and game state rather than reimplementing chess rules in the UI.
- Preserve SQLite compatibility. Schema changes should be additive migrations, following the migration pattern in `server.js`, so existing `data/chess.sqlite` profiles and game records survive upgrades.
- Keep rated friend-game stats, computer-game stats, and puzzle stats distinct. Bot or puzzle activity must not alter Elo.
- Follow existing naming, formatting, and CSS class patterns. Keep controls semantic and labelled; avoid adding dependencies for small UI behaviors.
- Keep generated/local data out of version control. `node_modules/` and `data/` are ignored; do not commit local SQLite databases, database journals, secrets, or machine-specific files.

## Validation

Use `npm test` for the existing smoke suite after changes affecting server behavior, persistence, chess rules, or WebSocket play. For frontend-only changes, inspect the relevant UI flows in a browser when practical. The suite launches its own isolated server and database; do not use the user's normal `data/chess.sqlite` as test data.
