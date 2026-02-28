# JimmyQrg Chat

A single group chat app with Free Chat, Support, Problem Solving, and Rules panels. Users can send private messages, upload files, reply, like, @mention, and (if allowed) use admin features. Dark, out-of-space purple theme.

## Features

- **Group "JimmyQrg"** with 4 panels:
  - **Free Chat** & **Support** – chat
  - **Problem Solving** & **Rules** – editable documents (allowed users only)
- **Private messages** between users
- **Default admin**: user `jimmyqrg` (password `changeme` – change after first login)
- **Allowed users** can: kick users, delete messages (permanent), send to inbox, change other users’ authority (jimmyqrg cannot be demoted)
- **All users**: upload images/videos/files, send voice messages, reply, like, recall/edit own messages within 2 minutes, edit history, change avatar and display name in profile
- **@mentions**: `@username`, `@All`
- **Inbox**: mentions, replies, admin messages, “your problem is solved” (when someone uses **Solve** on a Support message and edits Problem Solving)
- **Solve flow**: allowed users can right‑click a Support message → **Solve** → edit Problem Solving → author of that Support message gets an inbox link to the update

## Tech

- **Backend**: Node.js, Express, Socket.IO, SQLite (better-sqlite3), sessions
- **Frontend**: Vanilla JS, space/purple dark theme
- **Deploy**: fly.io (Dockerfile + volume for persistence)

## Local setup

- **Node**: 18 or 20 LTS recommended (native module `better-sqlite3` may need build tools; on macOS install Xcode Command Line Tools).
- **First run**:
```bash
npm install
npm run init-db
npm run dev
```

- App: http://localhost:3000  
- First admin login: `jimmyqrg` / `changeme`

## Deploy to fly.io

1. Install [flyctl](https://fly.io/docs/hands-on/install-flyctl/) and log in: `fly auth login`.

2. Create a volume (required for persistent DB and uploads):
   ```bash
   fly volumes create chat_data --region <your-region> --size 1
   ```
   Use the same region you pick for the app.

3. Launch (first time; use existing app name if you already have one):
   ```bash
   fly launch --no-deploy
   ```
   Ensure `fly.toml` has the `[mounts]` section pointing at `chat_data` and that the app name matches.

4. Set a strong session secret:
   ```bash
   fly secrets set SESSION_SECRET="your-random-secret"
   ```

5. Deploy:
   ```bash
   fly deploy
   ```

6. Change the default `jimmyqrg` password after first login (e.g. via profile/settings if you add a “change password” flow, or by updating the DB).

## Username rules

- Only lowercase letters and numbers.

## License

MIT
