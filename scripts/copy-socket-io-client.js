/**
 * Copies the Socket.IO browser bundle into public/ so game.html can load /socket.io.min.js
 * from the same origin. Runs on npm install; Dockerfile also copies after COPY.
 */
import { copyFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules/socket.io/client-dist/socket.io.min.js");
const dest = join(root, "public/socket.io.min.js");

mkdirSync(join(root, "public"), { recursive: true });
copyFileSync(src, dest);
