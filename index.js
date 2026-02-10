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

// CORS тохиргоо - Next.js dev server port нэмсэн
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001", // Next.js dev server - ЭНЭ ЧУХАЛ!
  "http://localhost:5173", // Vite
  CLIENT_URL,
].filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (mobile apps, Postman, etc)
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) !== -1 || NODE_ENV === "development") {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  }),
);

app.use(express.json());

// Health check endpoint - Render-ийн health check-д зориулсан
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: Date.now(),
    rooms: rooms.size,
    players: playerToSocket.size,
  });
});

// Root endpoint
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

const rooms = new Map();
const playerToSocket = new Map(); // playerId -> Set of socket.ids

// 🔧 FIXED: Helper to create initial game state for a player
function createPlayerGameState(playerId, playerIndex) {
  const colors = ["#FF6B6B", "#4ECDC4", "#FFE66D", "#A8DADC"];
  return {
    id: playerId,
    playerId: playerIndex,
    x: 100 + (playerIndex - 1) * 80, // Spread out players
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

// Helper: өрөөний төлөв илгээх (зөвхөн lobby мэдээлэл)
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

// 🔧 IMPROVED: Game state with proper player data
function emitGameState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const players = {};
  let idx = 1;

  for (const playerId of Object.keys(room.players)) {
    // Use existing game state if available, otherwise create new
    if (room.gameState?.players?.[playerId]) {
      players[playerId] = room.gameState.players[playerId];
    } else {
      players[playerId] = createPlayerGameState(playerId, idx);
    }
    idx++;
  }

  const gameState = {
    players,
    keyCollected: room.gameState?.keyCollected || false,
    playersAtDoor: room.gameState?.playersAtDoor || [],
    gameStatus: room.started ? "playing" : "waiting",
  };

  // Store game state in room
  room.gameState = gameState;

  io.to(roomCode).emit("gameState", gameState);

  console.log(`📤 Emitted game state to room ${roomCode}:`, {
    playerCount: Object.keys(players).length,
    playerIds: Object.keys(players),
    gameStatus: gameState.gameStatus,
  });
}

// Helper: Тоглогчийн бүх socket-уудыг салгах
function disconnectPlayer(playerId, roomCode) {
  const sockets = playerToSocket.get(playerId);
  if (!sockets) return;
  sockets.forEach((socketId) => {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.leave(roomCode);
      socket.data.roomCode = null;
      socket.data.playerId = null;
    }
  });
  playerToSocket.delete(playerId);
}

io.on("connection", (socket) => {
  console.log(`✅ Socket connected: ${socket.id}`);

  // CREATE ROOM
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
        gameState: null, // 🔧 ADD: Initialize game state
      };
      rooms.set(roomCode, room);

      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      socket.data.playerId = hostId;

      if (!playerToSocket.has(hostId)) {
        playerToSocket.set(hostId, new Set());
      }
      playerToSocket.get(hostId).add(socket.id);

      console.log(`📝 Room created: ${roomCode} by ${hostId}`);

      emitRoomState(roomCode);
      // 🔧 ADD: Send initial game state immediately
      emitGameState(roomCode);
    } catch (error) {
      console.error("Error in createRoom:", error);
      socket.emit("createDenied", { message: "Server error" });
    }
  });

  // 🔧 FIXED: JOIN ROOM - Now sends game state!
  socket.on("joinRoom", ({ roomCode, playerId }) => {
    try {
      console.log(`🔗 Join request - Room: ${roomCode}, Player: ${playerId}`);

      const room = rooms.get(roomCode);
      if (!room) {
        socket.emit("joinDenied", { message: "Room not found" });
        return;
      }

      // Тоглоом эхэлсэн үед орохыг хориглох
      if (room.started) {
        socket.emit("joinDenied", { message: "Game already started" });
        return;
      }

      // Хэрэв өмнө нь нэгдсэн байвал хуучин socket-уудыг салгах
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

      if (!playerToSocket.has(playerId)) {
        playerToSocket.set(playerId, new Set());
      }
      playerToSocket.get(playerId).add(socket.id);

      console.log(`✅ Player ${playerId} joined room ${roomCode}`);

      emitRoomState(roomCode);
      // 🔧 FIX: Send game state so players render!
      emitGameState(roomCode);

      socket.emit("joinSuccess", {
        roomCode,
        playerId,
        message: "Successfully joined room",
      });
    } catch (error) {
      console.error("Error in joinRoom:", error);
      socket.emit("joinDenied", { message: "Server error" });
    }
  });

  // SELECT HERO
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
    } catch (error) {
      console.error("Error in selectHero:", error);
    }
  });

  // SET READY
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
    } catch (error) {
      console.error("Error in setReady:", error);
    }
  });

  // START GAME
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
      emitGameState(roomCode); // Update with "playing" status
    } catch (error) {
      console.error("Error in startGameNow:", error);
      socket.emit("startDenied", { message: "Server error" });
    }
  });

  // 🔧 ADD: Handle player input for movement
  socket.on("playerInput", (input) => {
    try {
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) return;

      const room = rooms.get(roomCode);
      if (!room || !room.gameState) return;

      const player = room.gameState.players[playerId];
      if (!player || player.dead) return;

      // Update player based on input
      // (You'll need to add physics/collision logic here)
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

      // Simple physics update
      player.x += player.vx;
      player.y += player.vy;
      player.vy += 0.8; // gravity

      // Ground collision (simple)
      const groundY = 550; // Adjust based on your game
      if (player.y >= groundY) {
        player.y = groundY;
        player.vy = 0;
        player.onGround = true;
      }

      // Emit updated state to all players
      emitGameState(roomCode);
    } catch (error) {
      console.error("Error in playerInput:", error);
    }
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    console.log(`🔌 Socket disconnected: ${socket.id}`);
    try {
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) return;

      const sockets = playerToSocket.get(playerId);
      if (sockets) {
        sockets.delete(socket.id);

        // Хэрэв энэ тоглогчийн бүх socket салсан бол өрөөнөөс хас
        if (sockets.size === 0) {
          playerToSocket.delete(playerId);
          const room = rooms.get(roomCode);

          if (room) {
            delete room.players[playerId];

            // Remove from game state too
            if (room.gameState?.players?.[playerId]) {
              delete room.gameState.players[playerId];
            }

            if (Object.keys(room.players).length === 0) {
              rooms.delete(roomCode);
              console.log(`🗑️ Room ${roomCode} deleted (empty)`);
            } else {
              // Хэрэв host салсан бол шинэ host томилох
              if (room.hostId === playerId) {
                room.hostId = Object.keys(room.players)[0];
                console.log(`👑 New host: ${room.hostId} in room ${roomCode}`);
              }

              emitRoomState(roomCode);
              emitGameState(roomCode); // Update game state
            }
          }
        }
      }
    } catch (error) {
      console.error("Error in disconnect:", error);
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

// Server эхлүүлэх - 0.0.0.0 host ашиглах нь чухал
server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Socket server running on port ${PORT}`);
  console.log(`🌍 Environment: ${NODE_ENV}`);
  console.log(`🔓 Allowed origins:`, allowedOrigins);
});
