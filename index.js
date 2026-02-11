// server/index.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

// Environment variables
const PORT = process.env.PORT || 4000;
const NODE_ENV = process.env.NODE_ENV || "development";
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";

// CORS
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5173",
  CLIENT_URL,
].filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin) || NODE_ENV === "development") {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);

app.use(express.json());

const rooms = new Map(); // roomCode -> room
const playerToSocket = new Map(); // playerId -> Set(socket.id)

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: Date.now(),
    rooms: rooms.size,
    players: playerToSocket.size,
  });
});

app.get("/", (req, res) => {
  res.json({ message: "Game Server Running" });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ["websocket", "polling"],
});

// --- Helpers ---
function createPlayerGameState(playerId, playerIndex) {
  const colors = ["#FF6B6B", "#4ECDC4", "#FFE66D", "#A8DADC"];
  return {
    id: playerId,
    playerId: playerIndex,
    x: 100 + (playerIndex - 1) * 80,
    y: 300,
    vx: 0,
    vy: 0,
    width: 48,
    height: 48,
    onGround: false,
    animFrame: 0,
    facingRight: true,
    color: colors[(playerIndex - 1) % colors.length],
    dead: false,
    standingOnPlayer: null,
  };
}

function emitRoomState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  io.to(roomCode).emit("roomState", {
    roomCode: room.roomCode,
    maxPlayers: room.maxPlayers,
    hostId: room.hostId,
    started: room.started,
    players: room.players,
  });
}

function ensureGameState(room) {
  if (!room.gameState) {
    room.gameState = {
      players: {},
      keyCollected: false,
      playersAtDoor: [],
      gameStatus: room.started ? "playing" : "waiting",
    };
  }
}

function emitGameState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  ensureGameState(room);

  const players = {};
  let idx = 1;

  for (const pid of Object.keys(room.players)) {
    if (room.gameState.players?.[pid]) {
      players[pid] = room.gameState.players[pid];
    } else {
      players[pid] = createPlayerGameState(pid, idx);
    }
    idx++;
  }

  room.gameState = {
    players,
    keyCollected: room.gameState.keyCollected || false,
    playersAtDoor: room.gameState.playersAtDoor || [],
    gameStatus: room.started ? "playing" : "waiting",
  };

  io.to(roomCode).emit("gameState", room.gameState);

  console.log(`📤 gameState -> ${roomCode}`, {
    started: room.started,
    gameStatus: room.gameState.gameStatus,
    playerCount: Object.keys(players).length,
  });
}

function disconnectPlayer(playerId, roomCode) {
  const sockets = playerToSocket.get(playerId);
  if (!sockets) return;

  sockets.forEach((socketId) => {
    const s = io.sockets.sockets.get(socketId);
    if (s) {
      s.leave(roomCode);
      s.data.roomCode = null;
      s.data.playerId = null;
    }
  });

  playerToSocket.delete(playerId);
}

// ✅ AUTO START checker
function maybeAutoStart(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  if (room.started) return;

  const count = Object.keys(room.players).length;
  if (count !== room.maxPlayers) return;

  // optional: hero/ready шаардвал энд шалгана
  // const allPicked = Object.values(room.players).every(p => p.hero);
  // const allReady = Object.values(room.players).every(p => p.ready);
  // if (!allPicked || !allReady) return;

  room.started = true;
  io.to(roomCode).emit("startGame"); // optional event
  console.log(`🚀 Auto-started room ${roomCode}`);
}

// --- Socket.IO ---
io.on("connection", (socket) => {
  console.log(`✅ Socket connected: ${socket.id}`);

  socket.on("createRoom", ({ roomCode, maxPlayers, hostId }) => {
    try {
      if (!roomCode || !maxPlayers || !hostId) {
        socket.emit("createDenied", { message: "Invalid parameters" });
        return;
      }
      if (rooms.has(roomCode)) {
        socket.emit("createDenied", { message: "Room code already exists" });
        return;
      }

      const room = {
        roomCode,
        maxPlayers,
        hostId,
        started: false,
        players: {
          [hostId]: { hero: null, ready: false },
        },
        gameState: null,
      };

      rooms.set(roomCode, room);

      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      socket.data.playerId = hostId;

      if (!playerToSocket.has(hostId)) playerToSocket.set(hostId, new Set());
      playerToSocket.get(hostId).add(socket.id);

      console.log(`📝 Room created: ${roomCode} by ${hostId}`);

      emitRoomState(roomCode);
      emitGameState(roomCode);
    } catch (e) {
      console.error("Error in createRoom:", e);
      socket.emit("createDenied", { message: "Server error" });
    }
  });

  socket.on("joinRoom", ({ roomCode, playerId }) => {
    try {
      console.log(`🔗 Join request - Room: ${roomCode}, Player: ${playerId}`);

      const room = rooms.get(roomCode);
      if (!room) {
        socket.emit("joinDenied", { message: "Room not found" });
        return;
      }

      // started бол join хориглоно (чи хүсвэл allow reconnect гэж өөрчилж болно)
      if (room.started) {
        socket.emit("joinDenied", { message: "Game already started" });
        return;
      }

      // өмнө нь нэгдсэн байвал хуучин sockets салгана
      if (room.players[playerId]) {
        disconnectPlayer(playerId, roomCode);
      }

      const count = Object.keys(room.players).length;
      if (!room.players[playerId] && count >= room.maxPlayers) {
        socket.emit("joinDenied", { message: "Room full" });
        return;
      }

      if (!room.players[playerId]) {
        room.players[playerId] = { hero: null, ready: false };
      }

      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      socket.data.playerId = playerId;

      if (!playerToSocket.has(playerId))
        playerToSocket.set(playerId, new Set());
      playerToSocket.get(playerId).add(socket.id);

      console.log(`✅ Player ${playerId} joined room ${roomCode}`);

      // ✅ AUTO START when full
      maybeAutoStart(roomCode);

      emitRoomState(roomCode);
      emitGameState(roomCode);

      socket.emit("joinSuccess", {
        roomCode,
        playerId,
        message: "Successfully joined room",
      });
    } catch (e) {
      console.error("Error in joinRoom:", e);
      socket.emit("joinDenied", { message: "Server error" });
    }
  });

  socket.on("selectHero", ({ hero }) => {
    try {
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) return;

      const room = rooms.get(roomCode);
      if (!room || !room.players[playerId]) return;

      const taken = new Set(
        Object.entries(room.players)
          .filter(([pid, p]) => pid !== playerId && p.hero)
          .map(([, p]) => p.hero),
      );

      if (taken.has(hero)) {
        socket.emit("heroDenied", { message: "Hero already taken" });
        return;
      }

      room.players[playerId].hero = hero;
      room.players[playerId].ready = false;

      emitRoomState(roomCode);
    } catch (e) {
      console.error("Error in selectHero:", e);
    }
  });

  socket.on("setReady", ({ ready }) => {
    try {
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) return;

      const room = rooms.get(roomCode);
      if (!room) return;

      const player = room.players[playerId];
      if (!player) return;

      if (!player.hero) {
        socket.emit("readyDenied", { message: "Choose hero first" });
        return;
      }

      player.ready = Boolean(ready);

      emitRoomState(roomCode);

      // optional: бүх хүн ready болсон үед auto-start хийх бол:
      // maybeAutoStart(roomCode); emitGameState(roomCode);
    } catch (e) {
      console.error("Error in setReady:", e);
    }
  });

  socket.on("startGameNow", () => {
    try {
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) return;

      const room = rooms.get(roomCode);
      if (!room) return;

      if (room.hostId !== playerId) {
        socket.emit("startDenied", { message: "Only host can start" });
        return;
      }

      const allPicked = Object.values(room.players).every((p) => p.hero);
      if (!allPicked) {
        socket.emit("startDenied", { message: "Everyone must pick a hero" });
        return;
      }

      room.started = true;
      io.to(roomCode).emit("startGame");

      emitRoomState(roomCode);
      emitGameState(roomCode);
    } catch (e) {
      console.error("Error in startGameNow:", e);
      socket.emit("startDenied", { message: "Server error" });
    }
  });

  socket.on("playerInput", (input) => {
    try {
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) return;

      const room = rooms.get(roomCode);
      if (!room) return;

      ensureGameState(room);

      const player = room.gameState.players[playerId];
      if (!player || player.dead) return;

      if (input.left) {
        player.vx = -5;
        player.facingRight = false;
        player.animFrame = (player.animFrame + 1) % 4;
      } else if (input.right) {
        player.vx = 5;
        player.facingRight = true;
        player.animFrame = (player.animFrame + 1) % 4;
      } else {
        player.vx = 0;
      }

      if (input.jump && player.onGround) {
        player.vy = -15;
        player.onGround = false;
      }

      player.x += player.vx;
      player.y += player.vy;
      player.vy += 0.8;

      const groundY = 550;
      if (player.y >= groundY) {
        player.y = groundY;
        player.vy = 0;
        player.onGround = true;
      }

      emitGameState(roomCode);
    } catch (e) {
      console.error("Error in playerInput:", e);
    }
  });

  socket.on("disconnect", () => {
    console.log(`🔌 Socket disconnected: ${socket.id}`);

    try {
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) return;

      const sockets = playerToSocket.get(playerId);
      if (!sockets) return;

      sockets.delete(socket.id);

      if (sockets.size > 0) return;

      playerToSocket.delete(playerId);

      const room = rooms.get(roomCode);
      if (!room) return;

      delete room.players[playerId];
      if (room.gameState?.players?.[playerId])
        delete room.gameState.players[playerId];

      if (Object.keys(room.players).length === 0) {
        rooms.delete(roomCode);
        console.log(`🗑️ Room ${roomCode} deleted (empty)`);
        return;
      }

      if (room.hostId === playerId) {
        room.hostId = Object.keys(room.players)[0];
        console.log(`👑 New host: ${room.hostId} in room ${roomCode}`);
      }

      // ✅ started байхад хүн гарвал started=true хэвээр үлдээнэ
      emitRoomState(roomCode);
      emitGameState(roomCode);
    } catch (e) {
      console.error("Error in disconnect:", e);
    }
  });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, closing server...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Socket server running on port ${PORT}`);
  console.log(`🌍 Environment: ${NODE_ENV}`);
  console.log(`🔓 Allowed origins:`, allowedOrigins);
});
