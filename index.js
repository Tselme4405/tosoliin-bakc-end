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

// Helper: Game state (зөвхөн тоглоом эхэлсэн үед)

function emitGameState(roomCode) {
  const room = rooms.get(roomCode);

  if (!room || !room.started) return;

  const players = {};

  let idx = 1;

  for (const [pid, p] of Object.entries(room.players)) {
    players[pid] = {
      id: pid,

      playerId: idx,

      x: 200 + idx * 60,

      y: 300,

      width: 48,

      height: 48,

      facingRight: true,

      animFrame: 0,

      color: "#ffffff",

      dead: false,
    };

    idx++;
  }

  io.to(roomCode).emit("gameState", {
    players,

    keyCollected: false,

    playersAtDoor: [],

    gameStatus: "playing",
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
    } catch (error) {
      console.error("Error in createRoom:", error);

      socket.emit("createDenied", { message: "Server error" });
    }
  });

  // JOIN ROOM

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

      emitGameState(roomCode);
    } catch (error) {
      console.error("Error in startGameNow:", error);

      socket.emit("startDenied", { message: "Server error" });
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
