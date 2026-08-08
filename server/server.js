const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { getRoom, addMessage } = require('./rooms');

const PORT = process.env.PORT || 3001;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.get('/', (_req, res) => {
  res.type('text/plain').send('Netflix Watch Party server is running.');
});

// Serves the userscript with this deployment's own URL baked in, so
// installing straight from /netflix-watch-party.user.js "just works"
// on both devices with no manual editing, and @updateURL keeps it fresh.
app.get('/netflix-watch-party.user.js', (req, res) => {
  const scriptPath = path.join(__dirname, '..', 'userscript', 'netflix-watch-party.user.js');
  fs.readFile(scriptPath, 'utf8', (err, contents) => {
    if (err) {
      res.status(500).type('text/plain').send('// Could not load userscript');
      return;
    }
    const origin = `${req.protocol}://${req.get('host')}`;
    const scriptUrl = `${origin}/netflix-watch-party.user.js`;
    const populated = contents
      .replace(/__SERVER_URL__/g, origin)
      .replace(/__UPDATE_URL__/g, scriptUrl);
    res.type('text/javascript').send(populated);
  });
});

function broadcastPresence(roomCode) {
  const room = getRoom(roomCode);
  io.to(roomCode).emit('presence', {
    members: Array.from(room.members.values()),
  });
}

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomCode, username } = {}) => {
    if (!roomCode || !username) return;
    const cleanRoom = String(roomCode).trim().slice(0, 40);
    const cleanName = String(username).trim().slice(0, 24) || 'Guest';
    if (!cleanRoom) return;

    socket.data.roomCode = cleanRoom;
    socket.data.username = cleanName;
    socket.join(cleanRoom);

    const room = getRoom(cleanRoom);
    room.members.set(socket.id, cleanName);

    socket.emit('room-joined', {
      roomCode: cleanRoom,
      chatHistory: room.messages,
      members: Array.from(room.members.values()),
    });

    socket.to(cleanRoom).emit('chat-message', {
      system: true,
      text: `${cleanName} joined the party`,
      ts: Date.now(),
    });
    broadcastPresence(cleanRoom);
  });

  socket.on('chat-message', ({ text } = {}) => {
    const { roomCode, username } = socket.data;
    if (!roomCode || !text) return;
    const message = { username, text: String(text).slice(0, 1000), ts: Date.now() };
    addMessage(roomCode, message);
    io.to(roomCode).emit('chat-message', message);
  });

  socket.on('playback-event', (payload = {}) => {
    const { roomCode, username } = socket.data;
    if (!roomCode) return;
    socket.to(roomCode).emit('playback-sync', { ...payload, from: username });
  });

  socket.on('heartbeat', ({ time } = {}) => {
    const { roomCode } = socket.data;
    if (!roomCode || typeof time !== 'number') return;
    socket.to(roomCode).emit('heartbeat-sync', { time });
  });

  socket.on('disconnect', () => {
    const { roomCode, username } = socket.data;
    if (!roomCode) return;
    const room = getRoom(roomCode);
    room.members.delete(socket.id);
    socket.to(roomCode).emit('chat-message', {
      system: true,
      text: `${username} left the party`,
      ts: Date.now(),
    });
    broadcastPresence(roomCode);
  });
});

server.listen(PORT, () => {
  console.log(`Netflix Watch Party server listening on port ${PORT}`);
});
