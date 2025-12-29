import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import { nanoid } from "nanoid";

const app = express();
app.use(cors());

app.get("/health", (_, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;

/**
 * rooms[code] = {
 *   code,
 *   seats: { N,E,S,W },
 *   playerNames: { socketId: name },
 *   hands: { socketId: Card[] },
 *   table: { socketId: Card[] },
 *   discards: Card[],
 *   deck: Card[],
 *   started: boolean
 * }
 */
const rooms = new Map();

function makeRoomCode() {
  return nanoid(6).toUpperCase();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildTwoDecks() {
  const suits = ["S", "H", "D", "C"];
  const ranks = [2,3,4,5,6,7,8,9,10,11,12,13,14]; // A=14
  const cards = [];
  let idCounter = 0;

  for (let d = 0; d < 2; d++) {
    for (const suit of suits) {
      for (const rank of ranks) {
        cards.push({ id: `c_${d}_${idCounter++}`, suit, rank });
      }
    }
    // jokers per deck: black < red
    cards.push({ id: `j_${d}_b_${idCounter++}`, suit: null, rank: 15, jokerType: "BLACK" });
    cards.push({ id: `j_${d}_r_${idCounter++}`, suit: null, rank: 16, jokerType: "RED" });
  }

  return shuffle(cards);
}

function safeRoomStateFor(socketId, room) {
  const handCounts = {};
  for (const [sid, hand] of Object.entries(room.hands)) {
    handCounts[sid] = hand.length;
  }

  return {
    code: room.code,
    seats: room.seats,
    playerNames: room.playerNames || {},
    started: room.started,
    deckCount: room.deck.length,
    discardsCount: room.discards.length,
    table: room.table,
    yourHand: room.hands[socketId] || [],
    handCounts
  };
}

function broadcastRoom(room) {
  for (const sid of Object.keys(room.hands)) {
    io.to(sid).emit("room_state", safeRoomStateFor(sid, room));
  }
}

io.on("connection", (socket) => {
  console.log('Client connected:', socket.id);

  socket.on("create_room", () => {
    let code = makeRoomCode();
    while (rooms.has(code)) code = makeRoomCode();

    const room = {
      code,
      seats: { N: null, E: null, S: null, W: null },
      playerNames: {},
      hands: {},
      table: {},
      discards: [],
      deck: buildTwoDecks(),
      started: false
    };

    rooms.set(code, room);
    console.log('Room created:', code);
    socket.emit("room_created", { code });
  });

  socket.on("join_room", ({ code }) => {
    const room = rooms.get(code);
    if (!room) {
      console.log('Room not found:', code);
      return socket.emit("error_msg", { message: "Room not found." });
    }

    socket.join(code);
    room.hands[socket.id] = room.hands[socket.id] || [];
    room.table[socket.id] = room.table[socket.id] || [];

    console.log('Player joined room:', socket.id, code);
    socket.emit("joined_room", { code });
    broadcastRoom(room);
  });

 socket.on("sit", ({ code, seat, name }) => {
  const room = rooms.get(code);
  if (!room) return;

  if (!["N","E","S","W"].includes(seat)) return;

  const current = room.seats[seat];
  if (current && current !== socket.id) {
    return socket.emit("error_msg", { message: "Seat already taken." });
  }

  for (const s of ["N","E","S","W"]) {
    if (room.seats[s] === socket.id) room.seats[s] = null;
  }

  room.seats[seat] = socket.id;
  
  // Store player name
  if (name) {
    room.playerNames[socket.id] = name;
    console.log('Player sat down:', name, 'at seat', seat);
  }
  
  // Auto-start game when 4 players are seated
  const filled = Object.values(room.seats).filter(Boolean).length;
  if (filled === 4 && !room.started) {
    room.started = true;
    console.log('Game auto-started - all 4 players seated');
  }
  
  broadcastRoom(room);
});

  socket.on("start_game", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;

    const filled = Object.values(room.seats).filter(Boolean).length;
    if (filled < 4) {
      return socket.emit("error_msg", { message: "Need 4 players seated to start." });
    }

    room.started = true;
    console.log('Game started in room:', code);
    broadcastRoom(room);
  });

  socket.on("draw_card", ({ code }) => {
  const room = rooms.get(code);
  if (!room) {
    console.log('Draw card failed - room not found');
    return;
  }

    if (!room.hands[socket.id]) {
      return socket.emit("error_msg", { message: "Join the room first." });
    }

    if (room.deck.length === 0) {
      return socket.emit("error_msg", { message: "Deck is empty." });
    }

    const card = room.deck.pop();
    room.hands[socket.id].push(card);
    console.log('Card drawn by', socket.id, '- Deck remaining:', room.deck.length);
    broadcastRoom(room);
  });

  socket.on("play_cards", ({ code, cardIds }) => {
    const room = rooms.get(code);
    if (!room || !room.started) return;

    const hand = room.hands[socket.id];
    if (!hand) return;

    const toPlay = [];
    for (const cid of cardIds) {
      const idx = hand.findIndex(c => c.id === cid);
      if (idx >= 0) {
        const [c] = hand.splice(idx, 1);
        toPlay.push(c);
      }
    }

    room.table[socket.id] = [...(room.table[socket.id] || []), ...toPlay];
    console.log('Cards played by', socket.id, '- Cards:', toPlay.length);
    broadcastRoom(room);
  });

  socket.on("clear_trick", ({ code }) => {
  const room = rooms.get(code);
  if (!room) {
    console.log('Clear trick failed - room not found');
    return;
  }

    for (const sid of Object.keys(room.table)) {
      room.discards.push(...(room.table[sid] || []));
      room.table[sid] = [];
    }
    console.log('Trick cleared in room:', code);
    broadcastRoom(room);
  });

  socket.on("reset_round", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;

    room.deck = buildTwoDecks();
    room.discards = [];
    room.table = {};

    for (const sid of Object.keys(room.hands)) {
      room.hands[sid] = [];
      room.table[sid] = [];
    }

    room.started = false;
    console.log('Round reset in room:', code);
    broadcastRoom(room);
  });

  socket.on("disconnect", () => {
    console.log('Client disconnected:', socket.id);
    for (const room of rooms.values()) {
      let changed = false;

      for (const s of ["N","E","S","W"]) {
        if (room.seats[s] === socket.id) {
          room.seats[s] = null;
          changed = true;
        }
      }

      if (room.hands[socket.id]) {
        delete room.hands[socket.id];
        delete room.table[socket.id];
        delete room.playerNames[socket.id];
        changed = true;
      }

      if (changed) broadcastRoom(room);
    }
  });
});

server.listen(PORT, () => console.log(`Server running on ${PORT}`));
