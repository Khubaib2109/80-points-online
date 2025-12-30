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
  const ranks = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  const cards = [];
  let idCounter = 0;

  for (let d = 0; d < 2; d++) {
    for (const suit of suits) {
      for (const rank of ranks) {
        cards.push({ id: `c_${d}_${idCounter++}`, suit, rank });
      }
    }
    cards.push({ id: `j_${d}_b_${idCounter++}`, suit: null, rank: 15, jokerType: "BLACK" });
    cards.push({ id: `j_${d}_r_${idCounter++}`, suit: null, rank: 16, jokerType: "RED" });
  }

  return shuffle(cards);
}

function getNextSeat(currentSeat) {
  const order = ["N", "E", "S", "W"];
  const idx = order.indexOf(currentSeat);
  return order[(idx + 1) % 4];
}

function seatOf(room, socketId) {
  for (const [seat, sid] of Object.entries(room.seats)) {
    if (sid === socketId) return seat;
  }
  return null;
}

function pointsOf(cards) {
  // Common 80-points style counting:
  // 5 = 5 points, 10 = 10 points, K(13) = 10 points.
  let p = 0;
  for (const c of cards) {
    if (c.rank === 5) p += 5;
    else if (c.rank === 10) p += 10;
    else if (c.rank === 13) p += 10;
  }
  return p;
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
    currentTurn: room.currentTurn,
    trumpSuit: room.trumpSuit,
    startingPlayer: room.startingPlayer,
    bottomEightCount: room.bottomEight.length,
    phase: room.phase, // waiting, drawing, awaiting_bottom_eight, discarding_bottom_eight, playing
    started: room.started,
    deckCount: room.deck.length,
    discardsCount: room.discards.length,
    table: room.table,
    yourHand: room.hands[socketId] || [],
    handCounts,
    attackersScore: room.attackersScore || 0,
    lastAction: room.lastAction,
    // eligibility flags:
    canReshuffle:
      room.phase === "discarding_bottom_eight" &&
      room.startingPlayer &&
      seatOf(room, socketId) === room.startingPlayer &&
      pointsOf(room.hands[socketId] || []) < 25,
    yourPoints: pointsOf(room.hands[socketId] || []),
  };
}

function broadcastRoom(room) {
  for (const sid of Object.keys(room.hands)) {
    io.to(sid).emit("room_state", safeRoomStateFor(sid, room));
  }
}

function ensureGameStartIfReady(room) {
  const filled = Object.values(room.seats).filter(Boolean).length;
  if (filled === 4 && !room.started) {
    room.started = true;
    room.phase = "drawing";
    room.currentTurn = "N"; // N starts dealing/drawing rotation
    room.bottomEight = room.deck.splice(0, 8); // reserve 8 at start
    room.trumpSuit = null;
    room.startingPlayer = null;
    room.lastAction = null;
    // ensure table entries exist
    for (const sid of Object.values(room.seats)) {
      if (sid) room.table[sid] = room.table[sid] || [];
      if (sid) room.hands[sid] = room.hands[sid] || [];
    }
    console.log("Game started. Bottom 8 reserved.");
  }
}

function finishDrawingPhase(room) {
  // After all cards (except bottom 8) are drawn, starting player must pick up bottom 8
  room.phase = "awaiting_bottom_eight";
  room.currentTurn = null; // no one "turn" until starting player picks up bottom 8
  console.log("Drawing complete. Awaiting bottom 8 pickup by starting player:", room.startingPlayer);
}

function drawOneForSeat(room, seat) {
  const sid = room.seats[seat];
  if (!sid) return { ok: false, msg: "Seat empty." };

  if (room.hands[sid].length >= 25) return { ok: false, msg: "Hand full." };
  if (room.deck.length === 0) return { ok: false, msg: "Deck empty." };

  const card = room.deck.pop();
  room.hands[sid].push(card);

  if (card.rank === 2 && !room.trumpSuit) {
    room.trumpSuit = card.suit;
    room.startingPlayer = seat; // player who drew first 2 starts
    console.log("Trump suit set:", room.trumpSuit, "Starting player:", seat);
  }

  room.lastAction = { type: "draw", seat, cardId: card.id };
  return { ok: true, card };
}

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

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
      bottomEight: [],
      trumpSuit: null,
      startingPlayer: null,
      currentTurn: null,
      phase: "waiting",
      started: false,
      attackersScore: 0,
      lastAction: null,
    };

    rooms.set(code, room);

    socket.join(code);
    room.hands[socket.id] = [];
    room.table[socket.id] = [];

    socket.emit("room_created", { code });
    socket.emit("joined_room", { code });
    broadcastRoom(room);
  });

  socket.on("join_room", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit("error_msg", { message: "Room not found." });

    socket.join(code);
    room.hands[socket.id] = room.hands[socket.id] || [];
    room.table[socket.id] = room.table[socket.id] || [];

    socket.emit("joined_room", { code });
    broadcastRoom(room);
  });

  socket.on("sit", ({ code, seat, name }) => {
    const room = rooms.get(code);
    if (!room) return;

    if (!["N", "E", "S", "W"].includes(seat)) return;

    const current = room.seats[seat];
    if (current && current !== socket.id) {
      return socket.emit("error_msg", { message: "Seat already taken." });
    }

    // remove from any other seat
    for (const s of ["N", "E", "S", "W"]) {
      if (room.seats[s] === socket.id) room.seats[s] = null;
    }

    room.seats[seat] = socket.id;
    if (name) room.playerNames[socket.id] = name;

    ensureGameStartIfReady(room);
    broadcastRoom(room);
  });

  socket.on("draw_card", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;

    if (room.phase !== "drawing") {
      return socket.emit("error_msg", { message: "Not in drawing phase." });
    }

    const seat = seatOf(room, socket.id);
    if (!seat) return socket.emit("error_msg", { message: "You must be seated." });

    if (room.currentTurn !== seat) {
      return socket.emit("error_msg", { message: "Not your turn!" });
    }

    if (room.deck.length === 0) {
      finishDrawingPhase(room);
      broadcastRoom(room);
      return;
    }

    const res = drawOneForSeat(room, seat);
    if (!res.ok) return socket.emit("error_msg", { message: res.msg });

    room.currentTurn = getNextSeat(seat);

    if (room.deck.length === 0) {
      finishDrawingPhase(room);
    }

    broadcastRoom(room);
  });

  socket.on("auto_deal", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;

    if (room.phase !== "drawing") {
      return socket.emit("error_msg", { message: "Not in drawing phase." });
    }

    // Only allow auto deal if all 4 are seated (to avoid weird half-deals)
    const filled = Object.values(room.seats).filter(Boolean).length;
    if (filled !== 4) {
      return socket.emit("error_msg", { message: "Need 4 players seated to auto-deal." });
    }

    // Deal in strict turn order N→E→S→W, respecting hand limit, until deck empty
    let seat = room.currentTurn || "N";
    let safety = 2000;

    while (room.deck.length > 0 && safety-- > 0) {
      const sid = room.seats[seat];
      if (!sid) break;

      if (room.hands[sid].length < 25) {
        drawOneForSeat(room, seat);
      }

      seat = getNextSeat(seat);
    }

    room.currentTurn = seat; // where it would continue if someone manually draws (but deck is empty)
    finishDrawingPhase(room);
    broadcastRoom(room);
  });

  socket.on("undo_draw", ({ code }) => {
    const room = rooms.get(code);
    if (!room || !room.lastAction || room.lastAction.type !== "draw") {
      return socket.emit("error_msg", { message: "Nothing to undo." });
    }

    if (room.phase !== "drawing") {
      return socket.emit("error_msg", { message: "Undo only allowed during drawing phase." });
    }

    const last = room.lastAction;
    const lastSid = room.seats[last.seat];
    if (lastSid !== socket.id) {
      return socket.emit("error_msg", { message: "You can only undo your own draw." });
    }

    const hand = room.hands[socket.id];
    const idx = hand.findIndex((c) => c.id === last.cardId);
    if (idx >= 0) {
      const [card] = hand.splice(idx, 1);
      room.deck.push(card);

      // If that draw set the first trump, reset it
      if (room.startingPlayer === last.seat) {
        room.trumpSuit = null;
        room.startingPlayer = null;
      }

      room.currentTurn = last.seat;
      room.lastAction = null;
      broadcastRoom(room);
    }
  });

  socket.on("start_bottom_eight", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;

    if (room.phase !== "awaiting_bottom_eight") {
      return socket.emit("error_msg", { message: "Not time for bottom 8 yet." });
    }

    if (!room.startingPlayer) {
      return socket.emit("error_msg", { message: "Starting player not set (no 2 drawn yet)." });
    }

    const seat = seatOf(room, socket.id);
    if (seat !== room.startingPlayer) {
      return socket.emit("error_msg", { message: "Only starting player can pick up bottom 8." });
    }

    room.hands[socket.id].push(...room.bottomEight);
    room.bottomEight = [];
    room.phase = "discarding_bottom_eight";
    broadcastRoom(room);
  });

  socket.on("discard_bottom_eight", ({ code, cardIds }) => {
    const room = rooms.get(code);
    if (!room) return;

    if (room.phase !== "discarding_bottom_eight") {
      return socket.emit("error_msg", { message: "Not discarding bottom 8 right now." });
    }

    const seat = seatOf(room, socket.id);
    if (seat !== room.startingPlayer) {
      return socket.emit("error_msg", { message: "Only starting player can discard bottom 8." });
    }

    if (!Array.isArray(cardIds) || cardIds.length !== 8) {
      return socket.emit("error_msg", { message: "Must discard exactly 8 cards." });
    }

    const hand = room.hands[socket.id];
    const discarded = [];

    for (const cid of cardIds) {
      const idx = hand.findIndex((c) => c.id === cid);
      if (idx >= 0) {
        const [c] = hand.splice(idx, 1);
        discarded.push(c);
      }
    }

    if (discarded.length !== 8) {
      return socket.emit("error_msg", { message: "Could not find all 8 selected cards in hand." });
    }

    room.bottomEight = discarded; // stored as bottom 8 again
    room.phase = "playing";
    room.currentTurn = room.startingPlayer; // starting player leads
    broadcastRoom(room);
  });

  socket.on("reshuffle_round", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;

    if (room.phase !== "discarding_bottom_eight") {
      return socket.emit("error_msg", { message: "Reshuffle only allowed during bottom-8 exchange." });
    }

    const seat = seatOf(room, socket.id);
    if (seat !== room.startingPlayer) {
      return socket.emit("error_msg", { message: "Only starting player can reshuffle." });
    }

    const pts = pointsOf(room.hands[socket.id] || []);
    if (pts >= 25) {
      return socket.emit("error_msg", { message: "Reshuffle only allowed if you have <25 points." });
    }

    // Reset round, keep seating + names
    room.deck = buildTwoDecks();
    room.bottomEight = room.deck.splice(0, 8);
    room.discards = [];
    room.table = {};
    room.lastAction = null;
    room.trumpSuit = null;
    room.startingPlayer = null;
    room.phase = "drawing";
    room.currentTurn = "N";

    // clear hands
    for (const sid of Object.values(room.seats)) {
      if (!sid) continue;
      room.hands[sid] = [];
      room.table[sid] = [];
    }

    broadcastRoom(room);
  });

  socket.on("play_cards", ({ code, cardIds }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== "playing") return;

    const seat = seatOf(room, socket.id);
    if (!seat) return socket.emit("error_msg", { message: "You must be seated." });

    if (room.currentTurn !== seat) {
      return socket.emit("error_msg", { message: "Not your turn!" });
    }

    const hand = room.hands[socket.id] || [];
    const toPlay = [];

    for (const cid of cardIds || []) {
      const idx = hand.findIndex((c) => c.id === cid);
      if (idx >= 0) {
        const [c] = hand.splice(idx, 1);
        toPlay.push(c);
      }
    }

    room.table[socket.id] = toPlay;
    room.currentTurn = getNextSeat(seat);

    broadcastRoom(room);
  });

  socket.on("clear_trick", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;

    for (const sid of Object.keys(room.table)) {
      const cards = room.table[sid] || [];
      room.discards.push(...cards);
      room.table[sid] = [];
    }

    broadcastRoom(room);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      let changed = false;

      for (const s of ["N", "E", "S", "W"]) {
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
