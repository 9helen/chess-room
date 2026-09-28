# Chess Room

Chess Room is a browser chess MVP with username profiles, timed invite games, a built-in computer opponent, tactical puzzles, and a free practice board. Friend games are server validated and rated. Computer results and puzzle progress are saved separately and do not affect Elo.

## Run locally

Requires Node.js 14 or newer.

```sh
npm install
npm start
```

Open http://localhost:3000. Choose a username to load its profile. Friend games can use 10 minute Rapid, 3 minute Blitz, or untimed controls. Create a room and share its code, or join an existing room. The first player is White.

The server creates `data/chess.sqlite` on first run. Usernames are public profile identifiers; there are no passwords or account recovery. Set `PORT` to change the HTTP/WebSocket port, or `CHESS_DB_PATH` to use another SQLite file.

## Verify

```sh
npm test
```

The smoke suite launches an isolated server and checks profile persistence, legal move handling, puzzle positions, the computer move endpoint, and a timed friend game through WebSockets.
