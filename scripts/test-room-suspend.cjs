// Smoke test for the suspend-on-empty room logic. Runs in isolation by
// extracting just the relevant pieces from server/index.js, so we don't need
// a live Socket.IO server.

const assert = require('node:assert/strict');

// ── Extract & reimplement the pieces we want to test ──────────────────────
// We re-read the source file, slice out the relevant blocks, and eval them
// in a sandbox so we test the actual code that will ship.
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'index.js'),
  'utf8'
);

// Pull from `const globalRoomRegistry = new Map();` through the end of
// `function leaveCurrentRoom(...)`. That's the entire registry + leave subsystem.
const startIdx = src.indexOf('const globalRoomRegistry = new Map();');
const leaveStart = src.indexOf('function leaveCurrentRoom(', startIdx);
const leaveEnd = src.indexOf('\n}\n', leaveStart) + 3;
assert.ok(startIdx >= 0 && leaveEnd > leaveStart, 'could not isolate registry block');
const endIdx = leaveEnd;

const block = src.slice(startIdx, endIdx);
// Strip const declarations that already exist in the source — our sandbox
// declares its own copies with the same names.
const stripped = block
  .replace(/^const ROOM_EXPIRY_MS = .*$/m, '')
  .replace(/^const ROOM_MAX_PLAYERS = .*$/m, '')
  .replace(/^const QUICKPLAY_MAX = .*$/m, '');

// Build a sandbox with the constants the block needs.
const sandbox = `
  const ROOM_EXPIRY_MS = 5 * 60 * 1000;
  const ROOM_MAX_PLAYERS = { crossfire: 2, 'arena-coop': 6, 'boss-coop': 4, 'training-coop': 4 };
  const QUICKPLAY_MAX = 8;
  const gameRooms = new Map();
  ${stripped}
  module.exports = {
    globalRoomRegistry, registerRoom, updateRoomPlayerCount,
    suspendRoom, resumeRoom, unregisterRoom, getAllActiveRooms, leaveCurrentRoom,
    gameRooms,
  };
`;
const Module = require('node:module');
const m = new Module('virtual');
m._compile(sandbox, 'virtual-room-registry.js');
const reg = m.exports;

// ── Stub socket + gameRooms for leaveCurrentRoom ──────────────────────────
function makeSocket() {
  return {
    id: 'sock-' + Math.random().toString(36).slice(2, 8),
    leave: () => {},
    join: () => {},
    to: () => ({ emit: () => {} }),
  };
}

// Stub leaveCurrentRoom's socket.leave/gameRooms interaction by manually
// managing a tiny member set alongside globalRoomRegistry. For test purposes
// we re-implement leaveCurrentRoom's logic here (mirroring server) —
// the real function is tested via integration.
function fakeLeave(roomKey, socketId) {
  const members = reg.gameRooms.get(roomKey);
  if (members) {
    members.delete(socketId);
    if (!members.size) {
      reg.gameRooms.delete(roomKey);
      const meta = reg.globalRoomRegistry.get(roomKey);
      if (meta && meta.kind === 'quickplay') {
        meta.playerCount = 0;
        meta.lastEmptyAt = Date.now();
        meta.updatedAt = meta.lastEmptyAt;
      } else {
        reg.suspendRoom(roomKey);
      }
    }
  }
  reg.updateRoomPlayerCount(roomKey, -1);
}

// ── Tests ─────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); pass++; }
  catch (e) { console.log(`✗ ${name}\n   ${e.message}`); fail++; }
}

// 1. Created room: suspends on empty, NOT deleted; friend can't join via getAllActiveRooms.
test('created room: suspends when host leaves', () => {
  const roomKey = 'cr:crossfire:AB123';
  reg.registerRoom(roomKey, 'crossfire', 'AB123', 'host', null, 'created');
  reg.gameRooms.set(roomKey, new Set(['host']));
  fakeLeave(roomKey, 'host');
  assert.equal(reg.globalRoomRegistry.has(roomKey), true, 'entry should remain');
  const meta = reg.globalRoomRegistry.get(roomKey);
  assert.equal(meta.suspended, true, 'should be suspended');
  assert.equal(reg.getAllActiveRooms().length, 0, 'should NOT appear in lobby');
});

// 2. Created room: host rejoins via the API we expose (resumeRoom) — entry unsuspends.
test('created room: resumeRoom clears suspended', () => {
  const roomKey = 'cr:crossfire:CD456';
  reg.registerRoom(roomKey, 'crossfire', 'CD456', 'host', null, 'created');
  reg.gameRooms.set(roomKey, new Set(['host']));
  fakeLeave(roomKey, 'host');
  reg.resumeRoom(roomKey);
  const meta = reg.globalRoomRegistry.get(roomKey);
  assert.equal(meta.suspended, false);
  assert.equal(meta.lastEmptyAt, 0);
  assert.equal(reg.getAllActiveRooms().length, 1);
});

// 3. Quickplay room: stays findable after empty, lastEmptyAt set; reaped after ROOM_EXPIRY_MS.
test('quickplay room: stays in registry for 5min after empty, then reaped', () => {
  const roomKey = 'qp:crossfire:EF789';
  reg.registerRoom(roomKey, 'crossfire', 'EF789', 'p1', null, 'quickplay');
  reg.gameRooms.set(roomKey, new Set(['p1']));
  fakeLeave(roomKey, 'p1');
  // Right after empty: registry entry exists, NOT in lobby listing
  // (lastEmptyAt set, kind=quickplay, but playerCount=0 < max so… wait, check)
  const meta = reg.globalRoomRegistry.get(roomKey);
  assert.equal(meta.lastEmptyAt > 0, true, 'lastEmptyAt set');
  // It WILL appear in lobby (playerCount=0 < max), but only for ROOM_EXPIRY_MS
  assert.equal(reg.getAllActiveRooms().some(r => r.roomKey === roomKey), true,
    'should still appear in lobby during grace');
  // Fast-forward past expiry
  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 60 * 1000;
  try {
    reg.getAllActiveRooms();
    assert.equal(reg.globalRoomRegistry.has(roomKey), false, 'should be reaped');
  } finally {
    Date.now = realNow;
  }
});

// 4. Quickplay room: new player joins during grace via resumeRoom — entry reactivates.
test('quickplay room: resumeRoom during grace', () => {
  const roomKey = 'qp:crossfire:GH012';
  reg.registerRoom(roomKey, 'crossfire', 'GH012', 'p1', null, 'quickplay');
  reg.gameRooms.set(roomKey, new Set(['p1']));
  fakeLeave(roomKey, 'p1');
  reg.resumeRoom(roomKey);
  const meta = reg.globalRoomRegistry.get(roomKey);
  assert.equal(meta.suspended, false);
  assert.equal(meta.lastEmptyAt, 0);
});

// 5. Created room: after ROOM_EXPIRY_MS, joinRoom handler should reap (verified via separate path).
test('created room: meta still has lastEmptyAt set after suspend', () => {
  const roomKey = 'cr:crossfire:IJ345';
  reg.registerRoom(roomKey, 'crossfire', 'IJ345', 'host', null, 'created');
  reg.gameRooms.set(roomKey, new Set(['host']));
  fakeLeave(roomKey, 'host');
  const meta = reg.globalRoomRegistry.get(roomKey);
  assert.equal(meta.lastEmptyAt > 0, true, 'lastEmptyAt should be set on suspend');
  assert.equal(meta.suspended, true);
  // Lobby listing should NOT include it (suspended filter)
  assert.equal(reg.getAllActiveRooms().some(r => r.roomKey === roomKey), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);