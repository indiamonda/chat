# JimmyQrg Chat

JimmyQrg Chat is a real-time web chat app built around one shared group space plus direct messages. It combines normal chat, support conversations, editable reference pages, inbox notifications, and lightweight moderation tools in a single app.

## What This App Does

The app has two main communication modes:

- **Group chat** for shared conversation
- **Direct messages** for one-to-one chat between users

Inside the main group, users move between four panels:

- **Free Chat**: general discussion
- **Support**: help requests and support conversations
- **Problem Solving**: a shared editable page for documenting solutions
- **Rules**: a shared editable page for group rules or reference material

The chat experience is designed around persistent history, uploads, moderation, and searchable conversations.

## Main Features

### Messaging

- Real-time group chat and direct messages
- Replies, mentions, edit history, and message recall/edit for your own recent messages
- Permanent deletion of your own messages
- File uploads for images, video, audio, and other files
- Voice messages
- Emoji reactions on messages
- Per-room message drafts saved locally
- Full-text message search with filters
- Incremental message loading as you scroll upward through older history

### Organization

- **Inbox** for mentions, replies, admin messages, and support updates
- **Collections** to save important messages and reopen them later
- Link previews for supported URLs
- Desktop notification preferences and do-not-disturb settings

### Moderation and admin tools

- Admin/user permission system
- Group timeouts for temporarily blocking a user from sending messages
- Message deletion tools for moderators
- Admin inbox sending and broadcast sending
- Support workflow for marking a request as solved
- Basic anti-spam protection for repeated duplicate messages

## How The Main Workflows Work

### Group panels

- **Free Chat** and **Support** behave like message timelines.
- **Problem Solving** and **Rules** behave like shared documents instead of normal chat feeds.

### Inbox

The inbox is the app’s notification center. Users receive inbox entries for:

- mentions
- replies
- admin messages
- support messages marked as solved, when the solution is written up in **Problem Solving**

### Solve flow

The support workflow is:

1. A user posts in **Support**.
2. A moderator or allowed user marks that message as solved.
3. They update the **Problem Solving** page with the actual solution.
4. The original user receives an inbox item linking them to that update.

### Message search

Search is scoped to the current chat. It is not limited to only the messages already loaded on screen.

- Opening search from the chat header shows a query box and filter box.
- The app loads recent messages first and older messages in pages of 30 while scrolling.
- Search results are clickable and jump to the matching message in context.
- Filters support time ranges and sender filters such as `from:@username`.

### Collections

Collections let users save messages they want to return to later.

- Add a message to a collection from the message context menu.
- Each saved item keeps enough information to show who sent it and when.
- Opening a collection item returns you to the original chat/message context.

### Anti-spam

If a user sends more than two identical messages within a short window, the app temporarily blocks that user from sending for 5 seconds and shows `NO SPAMMING!`. The default `jimmyqrg` account is excluded from this rule.

## Running Locally

### Requirements

- Node.js 18+
- Build tools required by `better-sqlite3`
- On macOS, install Xcode Command Line Tools if native builds fail

### First-time setup

```bash
npm install
npm run init-db
npm run dev
```

Open: [http://localhost:3000](http://localhost:3000)

Default admin account:

- Username: `jimmyqrg`
- Password: `changeme`

Change this password immediately on first use.

### Available scripts

- `npm run dev`: start the server in watch mode
- `npm start`: start the server normally
- `npm run init-db`: initialize the database schema

## Data and Storage

This app stores data locally in SQLite.

- Default local data directory: `./data`
- Database file: `chat.db`
- Uploaded files and other persistent data also live under the configured data directory

You can override the storage location with `DATA_DIR`.

## Configuration

The app reads configuration from environment variables.

| Name | Required | Description |
|------|----------|-------------|
| `SESSION_SECRET` | Yes in production | Secret used to sign session cookies |
| `NODE_ENV` | No | Usually `production` in deployed environments |
| `PORT` | No | HTTP server port |
| `HOST` | No | HTTP server host |
| `DATA_DIR` | No | Directory for the SQLite database and persistent files |
| `ASSET_VERSION` | No | Optional cache-busting value for frontend assets |
| `ALLOW_IFRAME` | No | Set to `false` to disable iframe embedding |
| `COOKIE_SECURE` | No | Force secure cookies when needed |

Example production secret:

```bash
export SESSION_SECRET="$(openssl rand -base64 32)"
```

## Project Structure

This section is for developers who want to understand where the main pieces live before making changes.

### Main entrypoints

- `server/index.js`: Express server, Socket.IO setup, real-time events, API wiring, and message-related server logic
- `public/assets/js/main.js`: primary frontend app logic, UI state, rendering, routing, chat interactions, and client-side behavior
- `public/assets/js/api.js`: small frontend API helper layer
- `server/db.js`: SQLite connection, schema creation, and lightweight migrations
- `server/scripts/init-db.js`: database initialization script used by `npm run init-db`

### Server routes

Most HTTP features are split into focused route files under `server/routes/`:

- `auth.js`: login/signup/session-related routes
- `users.js`: profile and user data routes
- `docs.js`: shared document content such as `Problem Solving` and `Rules`
- `inbox.js`: inbox items and admin-delivered inbox messages
- `admin.js`: moderation/admin actions
- `friends.js`: friend requests, friendships, and DM-related access helpers
- `blocks.js`: user blocking
- `notifications.js`: desktop notification preferences and do-not-disturb settings

### Frontend structure

The frontend is mostly a single-page vanilla JavaScript app.

- Routing and screen rendering are handled in `public/assets/js/main.js`
- Most new chat features, such as search, drafts, collections, reactions, and pagination, are implemented in that same file
- Styling lives in `public/assets/css/style.css`
- Translations live in `public/assets/translation/data.json`

### Data model

The app uses SQLite for persistent storage. Key data includes:

- users and sessions
- messages and uploads
- inbox items
- friendships and blocks
- message reactions
- saved message collections
- group timeouts and admin permissions

If you are trying to trace how a feature works, start with the UI behavior in `public/assets/js/main.js`, then follow the related API route or Socket.IO handler in `server/index.js` or `server/routes/*.js`, and finally inspect the corresponding tables in `server/db.js`.

## Deploying To Fly.io

SQLite needs persistent disk storage, so deployment should use a volume.

1. Install [flyctl](https://fly.io/docs/hands-on/install-flyctl/) and log in:

```bash
fly auth login
```

2. Create a persistent volume:

```bash
fly volume create chat_data --region iad --size 1 -a jchat
```

3. Initialize the Fly app if needed:

```bash
fly launch --no-deploy
```

4. Set the session secret:

```bash
fly secrets set SESSION_SECRET="$(openssl rand -base64 32)"
```

5. Deploy:

```bash
fly deploy
```

If Fly reports that memory exceeds the platform limit, scale down first:

```bash
fly scale vm shared-cpu-1x --vm-memory 512 -a jchat
```

Then run `fly deploy` again.

## Username Rules

- Usernames may contain lowercase letters and numbers only.

## Production

- Live app: [https://jchat.fly.dev](https://jchat.fly.dev)

## License

MIT
