const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors({ origin: "http://localhost:3000" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "http://localhost:3000" },
});

// roomCode -> roomState
// roomState = { roomCode, maxPlayers, hostId, players: { [playerId]: { hero, ready } } }
const rooms = new Map();

// socket.id -> { roomCode, playerId }
const socketLink = new Map();

function emitRoomState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  io.to(roomCode).emit("roomState", room);
}

function isHeroTaken(room, hero, exceptPlayerId) {
  return Object.entries(room.players).some(([pid, p]) => {
    if (pid === exceptPlayerId) return false;
    return p.hero === hero;
  });
}

io.on("connection", (socket) => {
  // ✅ HOST: createRoom
  socket.on("createRoom", ({ roomCode, maxPlayers, hostId }) => {
    if (!roomCode || !hostId) return;

    // room already exists -> deny
    if (rooms.has(roomCode)) {
      socket.emit("createDenied", { message: "Room code already exists" });
      return;
    }

    const room = {
      roomCode,
      maxPlayers: Number(maxPlayers ?? 4),
      hostId,
      players: {
        [hostId]: { hero: null, ready: false },
      },
      started: false,
    };

    rooms.set(roomCode, room);

    socket.join(roomCode);
    socketLink.set(socket.id, { roomCode, playerId: hostId });

    emitRoomState(roomCode);
  });

  // ✅ JOIN: joinRoom
  socket.on("joinRoom", ({ roomCode, playerId }) => {
    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit("joinDenied", { message: "Room not found" });
      return;
    }

    if (room.started) {
      socket.emit("joinDenied", { message: "Game already started" });
      return;
    }

    const count = Object.keys(room.players).length;
    if (count >= room.maxPlayers && !room.players[playerId]) {
      socket.emit("joinDenied", { message: "Room is full" });
      return;
    }

    if (!room.players[playerId]) {
      room.players[playerId] = { hero: null, ready: false };
    }

    socket.join(roomCode);
    socketLink.set(socket.id, { roomCode, playerId });

    emitRoomState(roomCode);
  });

  // ✅ HERO select (давхардахгүй болгох гол хэсэг)
  socket.on("selectHero", ({ hero }) => {
    const link = socketLink.get(socket.id);
    if (!link) return;

    const { roomCode, playerId } = link;
    const room = rooms.get(roomCode);
    if (!room) return;

    const me = room.players[playerId];
    if (!me) return;

    if (room.started) {
      socket.emit("heroDenied", { message: "Game already started" });
      return;
    }

    if (isHeroTaken(room, hero, playerId)) {
      socket.emit("heroDenied", { message: "That hero is already taken" });
      return;
    }

    me.hero = hero;
    me.ready = false; // hero солиход ready reset

    emitRoomState(roomCode);
  });

  // ✅ READY (join хүн ready дарж болно, host ч дарж болно)
  socket.on("setReady", ({ ready }) => {
    const link = socketLink.get(socket.id);
    if (!link) return;

    const { roomCode, playerId } = link;
    const room = rooms.get(roomCode);
    if (!room) return;

    const me = room.players[playerId];
    if (!me) return;

    if (!me.hero) {
      socket.emit("readyDenied", { message: "Choose hero first" });
      return;
    }

    me.ready = Boolean(ready);
    emitRoomState(roomCode);
  });

  // ✅ HOST start game
  socket.on("startGameNow", () => {
    const link = socketLink.get(socket.id);
    if (!link) return;

    const { roomCode, playerId } = link;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (room.hostId !== playerId) {
      socket.emit("startDenied", { message: "Only host can start" });
      return;
    }

    // Бүгд hero сонгосон эсэх (гол шаардлага)
    const allPicked = Object.values(room.players).every((p) => !!p.hero);
    if (!allPicked) {
      socket.emit("startDenied", { message: "Everyone must pick a hero" });
      return;
    }

    // (сонголт) Бүгд ready байх ёстой бол:
    // const allReady = Object.values(room.players).every((p) => p.ready);
    // if (!allReady) return socket.emit("startDenied", { message: "Everyone must be ready" });

    room.started = true;
    io.to(roomCode).emit("startGame");
    emitRoomState(roomCode);
  });

  // ✅ disconnect: player гарахад hero чөлөөлөгдөнө
  socket.on("disconnect", () => {
    const link = socketLink.get(socket.id);
    socketLink.delete(socket.id);
    if (!link) return;

    const { roomCode, playerId } = link;
    const room = rooms.get(roomCode);
    if (!room) return;

    delete room.players[playerId];

    if (Object.keys(room.players).length === 0) {
      rooms.delete(roomCode);
      return;
    }

    // host гарвал эхний хүнийг host болгоно
    if (room.hostId === playerId) {
      room.hostId = Object.keys(room.players)[0];
    }

    emitRoomState(roomCode);
  });
});

server.listen(4000, () =>
  console.log("✅ Socket server running: http://localhost:4000"),
);
