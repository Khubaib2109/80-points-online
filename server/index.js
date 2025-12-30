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
  const ranks = [2,3,4,5,6,7,8,9,10,11,12,13,14];
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
  const order = ['N', 'E', 'S', 'W'];
  const idx = order.indexOf(currentSeat);
  return order[(idx + 1) % 4];
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
    bottomEight: room.bottomEight,
    phase: room.phase,
    started: room.started,
    deckCount: room.deck.length,
    discardsCount: room.discards.length,
    table: room.table,
    yourHand: room.hands[socketId] || [],
    handCounts,
    attackersScore: room.attackersScore || 0,
    lastAction: room.lastAction
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
      attackersTricks: [],
      deck: buildTwoDecks(),
      bottomEight: [],
      trumpSuit: null,
      startingPlayer: null,
      currentTurn: null,
      phase: 'waiting', // waiting, drawing, playing, round_end
      started: false,
      attackersScore: 0,
      lastAction: null
    };

    rooms.set(code, room);
    
    // Auto-join the room creator
    socket.join(code);
    room.hands[socket.id] = [];
    room.table[socket.id] = [];
    
    console.log('Room created:', code);
    socket.emit("room_created", { code });
    socket.emit("joined_room", { code });
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

    // Remove player from any other seat
    for (const s of ["N","E","S","W"]) {
      if (room.seats[s] === socket.id) room.seats[s] = null;
    }

    room.seats[seat] = socket.id;
    
    if (name) {
      room.playerNames[socket.id] = name;
      console.log('Player sat down:', name, 'at seat', seat);
    }
    
    // Auto-start when 4 players seated
    const filled = Object.values(room.seats).filter(Boolean).length;
    if (filled === 4 && !room.started) {
      room.started = true;
      room.phase = 'drawing';
      room.currentTurn = 'N'; // North starts
      // Set bottom 8 cards
      room.bottomEight = room.deck.splice(0, 8);
      console.log('Game started - all 4 players seated. Bottom 8 set.');
    }
    
    broadcastRoom(room);
  });

  socket.on("draw_card", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;

    if (room.phase !== 'drawing') {
      return socket.emit("error_msg", { message: "Not in drawing phase." });
    }

    // Find which seat this player is in
    let playerSeat = null;
    for (const [seat, sid] of Object.entries(room.seats)) {
      if (sid === socket.id) {
        playerSeat = seat;
        break;
      }
    }

    if (!playerSeat) {
      return socket.emit("error_msg", { message: "You must sit down first." });
    }

    // Check if it's this player's turn
    if (room.currentTurn !== playerSeat) {
      return socket.emit("error_msg", { message: "Not your turn!" });
    }

    // Check hand size limit
    if (room.hands[socket.id].length >= 25) {
      return socket.emit("error_msg", { message: "Hand is full (25 cards max)." });
    }

    if (room.deck.length === 0) {
      // All cards drawn, move to playing phase
      room.phase = 'playing';
      room.currentTurn = room.startingPlayer || 'N';
      console.log('Drawing complete. Starting player:', room.currentTurn);
      broadcastRoom(room);
      return;
    }

    const card = room.deck.pop();
    room.hands[socket.id].push(card);

    // Check if this is a 2 and set trump/starting player
    if (card.rank === 2 && !room.trumpSuit) {
      room.trumpSuit = card.suit;
      room.startingPlayer = playerSeat;
      console.log('Trump suit set:', room.trumpSuit, 'Starting player:', playerSeat);
    }

    room.lastAction = {
      type: 'draw',
      seat: playerSeat,
      cardId: card.id
    };

    // Move to next player's turn
    room.currentTurn = getNextSeat(playerSeat);

    console.log('Card drawn by', playerSeat, '- Deck remaining:', room.deck.length);
    broadcastRoom(room);
  });

  socket.on("undo_draw", ({ code }) => {
    const room = rooms.get(code);
    if (!room || !room.lastAction || room.lastAction.type !== 'draw') {
      return socket.emit("error_msg", { message: "Nothing to undo." });
    }

    const lastAction = room.lastAction;
    const playerSocketId = room.seats[lastAction.seat];
    
    if (playerSocketId !== socket.id) {
      return socket.emit("error_msg", { message: "You can only undo your own actions." });
    }

    // Find and remove the card
    const hand = room.hands[socket.id];
    const cardIdx = hand.findIndex(c => c.id === lastAction.cardId);
    
    if (cardIdx >= 0) {
      const [card] = hand.splice(cardIdx, 1);
      room.deck.push(card);
      
      // Reset trump if this was the first 2
      if (room.startingPlayer === lastAction.seat) {
        room.trumpSuit = null;
        room.startingPlayer = null;
      }
      
      // Go back to previous turn
      room.currentTurn = lastAction.seat;
      room.lastAction = null;
      
      console.log('Undo draw by', lastAction.seat);
      broadcastRoom(room);
    }
  });

  socket.on("play_cards", ({ code, cardIds }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'playing') return;

    const hand = room.hands[socket.id];
    if (!hand) return;

    let playerSeat = null;
    for (const [seat, sid] of Object.entries(room.seats)) {
      if (sid === socket.id) {
        playerSeat = seat;
        break;
      }
    }

    if (!playerSeat || room.currentTurn !== playerSeat) {
      return socket.emit("error_msg", { message: "Not your turn!" });
    }

    const toPlay = [];
    for (const cid of cardIds) {
      const idx = hand.findIndex(c => c.id === cid);
      if (idx >= 0) {
        const [c] = hand.splice(idx, 1);
        toPlay.push(c);
      }
    }

    room.table[socket.id] = toPlay;
    room.currentTurn = getNextSeat(playerSeat);
    
    console.log('Cards played by', playerSeat, '- Cards:', toPlay.length);
    
    // Check if trick is complete (all 4 players played)
    const playedCount = Object.values(room.table).filter(cards => cards && cards.length > 0).length;
    if (playedCount === 4) {
      // TODO: Determine trick winner and award points
      console.log('Trick complete!');
    }
    
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
    
    console.log('Trick cleared in room:', code);
    broadcastRoom(room);
  });

  socket.on("start_bottom_eight", ({ code }) => {
    const room = rooms.get(code);
    if (!room || !room.startingPlayer) return;

    let playerSeat = null;
    for (const [seat, sid] of Object.entries(room.seats)) {
      if (sid === socket.id) {
        playerSeat = seat;
        break;
      }
    }

    if (playerSeat !== room.startingPlayer) {
      return socket.emit("error_msg", { message: "Only starting player can pick bottom 8." });
    }

    // Give bottom 8 to starting player
    room.hands[socket.id].push(...room.bottomEight);
    room.bottomEight = [];
    room.phase = 'discarding_bottom_eight';
    
    broadcastRoom(room);
  });

  socket.on("discard_bottom_eight", ({ code, cardIds }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'discarding_bottom_eight') return;

    if (cardIds.length !== 8) {
      return socket.emit("error_msg", { message: "Must discard exactly 8 cards." });
    }

    const hand = room.hands[socket.id];
    const discarded = [];
    
    for (const cid of cardIds) {
      const idx = hand.findIndex(c => c.id === cid);
      if (idx >= 0) {
        const [c] = hand.splice(idx, 1);
        discarded.push(c);
      }
    }

    room.bottomEight = discarded;
    room.phase = 'playing';
    room.currentTurn = room.startingPlayer;
    
    console.log('Bottom 8 discarded by starting player');
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
