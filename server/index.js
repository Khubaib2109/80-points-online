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
const rooms = new Map();

/* ---------- helpers ---------- */

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
  const ranks = [2,3,4,5,6,7,8,9,10,11,12,13,14];
  const cards = [];
  let id = 0;

  for (let d = 0; d < 2; d++) {
    for (const suit of suits) {
      for (const rank of ranks) {
        cards.push({ id: `c_${d}_${id++}`, suit, rank });
      }
    }
    cards.push({ id: `j_${d}_b_${id++}`, suit: null, rank: 15, jokerType: "BLACK" });
    cards.push({ id: `j_${d}_r_${id++}`, suit: null, rank: 16, jokerType: "RED" });
  }

  return shuffle(cards);
}

const SEATS = ["N","E","S","W"];

function getNextSeat(seat) {
  return SEATS[(SEATS.indexOf(seat) + 1) % 4];
}

/* draw ONE card exactly like manual draw */
function drawOneCard(room, seat) {
  const socketId = room.seats[seat];
  if (!socketId) return;

  if (room.hands[socketId].length >= 25) return;
  if (room.deck.length === 0) return;

  const card = room.deck.pop();
  room.hands[socketId].push(card);

  if (card.rank === 2 && !room.trumpSuit) {
    room.trumpSuit = card.suit;
    room.startingPlayer = seat;
  }

  room.currentTurn = getNextSeat(seat);
}

/* ---------- state helpers ---------- */

function safeRoomStateFor(socketId, room) {
  const handCounts = {};
  for (const [sid, hand] of Object.entries(room.hands)) {
    handCounts[sid] = hand.length;
  }

  return {
    code: room.code,
    seats: room.seats,
    playerNames: room.playerNames,
    currentTurn: room.currentTurn,
    trumpSuit: room.trumpSuit,
    startingPlayer: room.startingPlayer,
    bottomEight: room.bottomEight,
    phase: room.phase,
    deckCount: room.deck.length,
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

/* ---------- socket ---------- */

io.on("connection", (socket) => {

  socket.on("create_room", () => {
    const code = makeRoomCode();

    const room = {
      code,
      seats: { N:null, E:null, S:null, W:null },
      playerNames: {},
      hands: {},
      table: {},
      deck: buildTwoDecks(),
      bottomEight: [],
      trumpSuit: null,
      startingPlayer: null,
      currentTurn: null,
      phase: "waiting"
    };

    rooms.set(code, room);
    socket.join(code);
    room.hands[socket.id] = [];
    room.table[socket.id] = {};

    socket.emit("room_created", { code });
    socket.emit("joined_room", { code });
  });

  socket.on("join_room", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit("error_msg", { message: "Room not found" });

    socket.join(code);
    room.hands[socket.id] = [];
    room.table[socket.id] = {};
    broadcastRoom(room);
  });

  socket.on("sit", ({ code, seat, name }) => {
    const room = rooms.get(code);
    if (!room) return;

    for (const s of SEATS) {
      if (room.seats[s] === socket.id) room.seats[s] = null;
    }

    room.seats[seat] = socket.id;
    room.playerNames[socket.id] = name || "Player";

    if (Object.values(room.seats).filter(Boolean).length === 4) {
      room.phase = "drawing";
      room.currentTurn = "N";
      room.bottomEight = room.deck.splice(0, 8);
    }

    broadcastRoom(room);
  });

  /* ---------- AUTO DEAL ---------- */

  socket.on("auto_deal", ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== "drawing") return;

    let seat = room.currentTurn;

    while (room.deck.length > 0) {
      drawOneCard(room, seat);
      seat = room.currentTurn;
    }

    room.phase = "awaiting_bottom_eight";
    room.currentTurn = room.startingPlayer;

    broadcastRoom(room);
  });

  /* ---------- MANUAL DRAW ---------- */

  socket.on("draw_card", ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== "drawing") return;

    const seat = Object.entries(room.seats)
      .find(([,sid]) => sid === socket.id)?.[0];

    if (seat !== room.currentTurn) return;

    drawOneCard(room, seat);

    if (room.deck.length === 0) {
      room.phase = "awaiting_bottom_eight";
      room.currentTurn = room.startingPlayer;
    }

    broadcastRoom(room);
  });

  socket.on("start_bottom_eight", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;

    const seat = Object.entries(room.seats)
      .find(([,sid]) => sid === socket.id)?.[0];

    if (seat !== room.startingPlayer) return;

    room.hands[socket.id].push(...room.bottomEight);
    room.bottomEight = [];
    room.phase = "discarding_bottom_eight";

    broadcastRoom(room);
  });

  socket.on("discard_bottom_eight", ({ code, cardIds }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== "discarding_bottom_eight") return;

    const hand = room.hands[socket.id];
    if (cardIds.length !== 8) return;

    cardIds.forEach(id => {
      const idx = hand.findIndex(c => c.id === id);
      if (idx >= 0) hand.splice(idx, 1);
    });

    room.phase = "playing";
    room.currentTurn = room.startingPlayer;

    broadcastRoom(room);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      for (const s of SEATS) {
        if (room.seats[s] === socket.id) room.seats[s] = null;
      }
      delete room.hands[socket.id];
      delete room.playerNames[socket.id];
      broadcastRoom(room);
    }
  });
});

server.listen(PORT, () =>
  console.log(`Server running on ${PORT}`)
);
