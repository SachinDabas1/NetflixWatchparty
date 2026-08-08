const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const MAX_HISTORY = 500; // cap stored messages per room, oldest are dropped

// In-memory room state: roomCode -> { members: Map<socketId, username>, messages: [] }
const rooms = new Map();

// One write queue per room so overlapping chat-message writes can't
// corrupt the JSON file (last write always wins, in order).
const writeQueues = new Map();

function safeFileName(roomCode) {
  return roomCode.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function dataFile(roomCode) {
  return path.join(DATA_DIR, `${safeFileName(roomCode)}.json`);
}

function loadHistory(roomCode) {
  const file = dataFile(roomCode);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.messages) ? parsed.messages : [];
  } catch (err) {
    console.error(`Failed to read chat history for room "${roomCode}":`, err.message);
    return [];
  }
}

function saveHistory(roomCode, messages) {
  const file = dataFile(roomCode);
  const trimmed = messages.slice(-MAX_HISTORY);
  const payload = JSON.stringify({ messages: trimmed }, null, 2);

  const prev = writeQueues.get(roomCode) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => fs.promises.writeFile(file, payload, 'utf8'))
    .catch((err) => console.error(`Failed to save chat history for room "${roomCode}":`, err.message));
  writeQueues.set(roomCode, next);
  return next;
}

function getRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, {
      members: new Map(),
      messages: loadHistory(roomCode),
    });
  }
  return rooms.get(roomCode);
}

function addMessage(roomCode, message) {
  const room = getRoom(roomCode);
  room.messages.push(message);
  if (room.messages.length > MAX_HISTORY) {
    room.messages = room.messages.slice(-MAX_HISTORY);
  }
  saveHistory(roomCode, room.messages);
  return room.messages;
}

module.exports = { getRoom, addMessage, rooms };
