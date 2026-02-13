const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

const PORT = process.env.PORT || 4000;
const NODE_ENV = process.env.NODE_ENV || "development";
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS || 15000);

const normalizeOrigin = (u) => {
  if (!u) return u;
  return u.trim().replace(/\/+$/, "");
};

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5173",
  ...CLIENT_URL.split(","),
]
  .map(normalizeOrigin)
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (NODE_ENV === "development") return true;
  return allowedOrigins.includes(normalizeOrigin(origin));
}

app.use(
  cors({
    origin(origin, cb) {
      if (isOriginAllowed(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);

app.use(express.json());

const rooms = new Map(); // roomCode -> room
const playerToSocket = new Map(); // playerId -> Set(socket.id)
const pendingDisconnects = new Map(); // playerId -> Timeout

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: Date.now(),
    rooms: rooms.size,
    players: playerToSocket.size,
  });
});

app.get("/", (req, res) => res.json({ message: "Game Server Running" }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin(origin, cb) {
      if (isOriginAllowed(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ["websocket", "polling"],
});

// ---------- Helpers ----------
function clearPendingDisconnect(playerId) {
  const t = pendingDisconnects.get(playerId);
  if (t) {
    clearTimeout(t);
    pendingDisconnects.delete(playerId);
  }
}

function createPlayerGameState(clientPlayerId, slot) {
  const colors = ["#FF6B6B", "#4ECDC4", "#FFE66D", "#A8DADC"];
  return {
    id: slot, // IMPORTANT: numeric slot 1..4 for frontend sprite selection
    clientPlayerId, // original UUID
    playerId: slot, // keep compatibility with old frontend naming
    x: 100 + (slot - 1) * 80,
    y: 300,
    vx: 0,
    vy: 0,
    width: 48,
    height: 48,
    onGround: false,
    animFrame: 0,
    facingRight: true,
    color: colors[(slot - 1) % colors.length],
    dead: false,
    standingOnPlayer: null,
  };
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

function playerIndexOf(room, playerId) {
  return room.playerOrder.indexOf(playerId) + 1;
}

function ensurePlayerState(room, playerId) {
  ensureGameState(room);
  const slot = playerIndexOf(room, playerId);
  if (slot < 1) return null;

  const prev = room.gameState.players[playerId];
  if (!prev) {
    room.gameState.players[playerId] = createPlayerGameState(playerId, slot);
  } else {
    // Normalize id/slot every time to keep frontend stable.
    prev.id = slot;
    prev.playerId = slot;
    prev.clientPlayerId = playerId;
  }
  return room.gameState.players[playerId];
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

function emitGameState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  ensureGameState(room);

  const players = {};
  for (const pid of room.playerOrder) {
    if (!room.players[pid]) continue;
    players[pid] = ensurePlayerState(room, pid);
  }

  room.gameState = {
    players,
    keyCollected: Boolean(room.gameState.keyCollected),
    playersAtDoor: Array.isArray(room.gameState.playersAtDoor)
      ? room.gameState.playersAtDoor
      : [],
    gameStatus: room.started ? "playing" : "waiting",
  };

  io.to(roomCode).emit("gameState", room.gameState);
}

function disconnectPlayerSocketsOnly(playerId, roomCode) {
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

function allPicked(room) {
  return Object.values(room.players).every((p) => p.hero);
}
function allReady(room) {
  return Object.values(room.players).every((p) => p.ready);
}

function parseInputPayload(payload) {
  const raw = payload?.input ?? payload ?? {};
  return {
    left: Boolean(raw.left),
    right: Boolean(raw.right),
    jump: Boolean(raw.jump),
  };
}

function applyPlayerInput(socket, payload) {
  try {
    const { roomCode, playerId } = socket.data;
    if (!roomCode || !playerId) return;

    const room = rooms.get(roomCode);
    if (!room || !room.started) return;

    const player = ensurePlayerState(room, playerId);
    if (!player || player.dead) return;

    const { left, right, jump } = parseInputPayload(payload);

    if (left) {
      player.vx = -5;
      player.facingRight = false;
      player.animFrame = (player.animFrame + 1) % 4;
    } else if (right) {
      player.vx = 5;
      player.facingRight = true;
      player.animFrame = (player.animFrame + 1) % 4;
    } else {
      player.vx = 0;
    }

    if (jump && player.onGround) {
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
    console.error("playerInput error:", e);
  }
}

// ---------- Socket.IO ----------
io.on("connection", (socket) => {
  console.log("✅ Socket connected:", socket.id);

  socket.on("createRoom", ({ roomCode, maxPlayers, hostId }) => {
    try {
      const max = Number(maxPlayers);

      if (
        !roomCode ||
        !hostId ||
        !Number.isInteger(max) ||
        max < 1 ||
        max > 4
      ) {
        socket.emit("createDenied", "Invalid parameters");
        return;
      }

      if (rooms.has(roomCode)) {
        socket.emit("createDenied", "Room code already exists");
        return;
      }

      clearPendingDisconnect(hostId);

      const room = {
        roomCode,
        maxPlayers: max,
        hostId,
        started: false,
        playerOrder: [hostId],
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

      console.log("📝 Room created:", roomCode, "by", hostId);

      emitRoomState(roomCode);
      emitGameState(roomCode);

      socket.emit("joinSuccess", {
        roomCode,
        playerId: hostId, // UUID
        playerIndex: 1, // numeric slot
        message: "Host created room",
      });
    } catch (e) {
      console.error("createRoom error:", e);
      socket.emit("createDenied", "Server error");
    }
  });

  socket.on("joinRoom", ({ roomCode, playerId }) => {
    try {
      if (!roomCode || !playerId) {
        socket.emit("joinDenied", { message: "Invalid parameters" });
        return;
      }

      const room = rooms.get(roomCode);
      if (!room) {
        socket.emit("joinDenied", { message: "Room not found" });
        return;
      }

      clearPendingDisconnect(playerId);

      // Allow rejoin of existing player even after start.
      if (room.started && !room.players[playerId]) {
        socket.emit("joinDenied", { message: "Game already started" });
        return;
      }

      // If same logical player has stale sockets, detach them only.
      if (room.players[playerId]) {
        disconnectPlayerSocketsOnly(playerId, roomCode);
      }

      const count = Object.keys(room.players).length;
      if (!room.players[playerId] && count >= room.maxPlayers) {
        socket.emit("joinDenied", { message: "Room full" });
        return;
      }

      if (!room.players[playerId]) {
        room.players[playerId] = { hero: null, ready: false };
        room.playerOrder.push(playerId);
      }

      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      socket.data.playerId = playerId;

      if (!playerToSocket.has(playerId))
        playerToSocket.set(playerId, new Set());
      playerToSocket.get(playerId).add(socket.id);

      emitRoomState(roomCode);
      emitGameState(roomCode);

      socket.emit("joinSuccess", {
        roomCode,
        playerId, // UUID
        playerIndex: playerIndexOf(room, playerId), // numeric slot
        message: "Successfully joined room",
      });
    } catch (e) {
      console.error("joinRoom error:", e);
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
      console.error("selectHero error:", e);
    }
  });

  socket.on("setReady", ({ ready }) => {
    try {
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) return;

      const room = rooms.get(roomCode);
      if (!room) return;

      const p = room.players[playerId];
      if (!p) return;

      if (!p.hero) {
        socket.emit("readyDenied", { message: "Choose hero first" });
        return;
      }

      p.ready = Boolean(ready);
      emitRoomState(roomCode);
    } catch (e) {
      console.error("setReady error:", e);
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

      if (!allPicked(room)) {
        socket.emit("startDenied", { message: "Everyone must pick a hero" });
        return;
      }
      if (!allReady(room)) {
        socket.emit("startDenied", { message: "Everyone must be ready" });
        return;
      }

      room.started = true;
      io.to(roomCode).emit("startGame");

      emitRoomState(roomCode);
      emitGameState(roomCode);
    } catch (e) {
      console.error("startGameNow error:", e);
      socket.emit("startDenied", { message: "Server error" });
    }
  });

  socket.on("playerInput", (payload) => applyPlayerInput(socket, payload));
  socket.on("playerMove", (payload) => applyPlayerInput(socket, payload)); // compatibility

  socket.on("disconnect", () => {
    try {
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) return;

      const sockets = playerToSocket.get(playerId);
      if (!sockets) return;

      sockets.delete(socket.id);
      if (sockets.size > 0) return;

      playerToSocket.delete(playerId);

      // Grace period for page navigation/reconnect.
      clearPendingDisconnect(playerId);
      const timer = setTimeout(() => {
        pendingDisconnects.delete(playerId);

        const room = rooms.get(roomCode);
        if (!room) return;

        // If player reconnected during grace, keep them.
        if (playerToSocket.has(playerId)) return;
        if (!room.players[playerId]) return;

        delete room.players[playerId];
        if (room.gameState?.players?.[playerId]) {
          delete room.gameState.players[playerId];
        }

        room.playerOrder = room.playerOrder.filter((x) => x !== playerId);

        if (Object.keys(room.players).length === 0) {
          rooms.delete(roomCode);
          return;
        }

        if (room.hostId === playerId) {
          room.hostId = Object.keys(room.players)[0];
        }

        emitRoomState(roomCode);
        emitGameState(roomCode);
      }, DISCONNECT_GRACE_MS);

      pendingDisconnects.set(playerId, timer);
    } catch (e) {
      console.error("disconnect error:", e);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Socket server running on port ${PORT}`);
  console.log(`🌍 Environment: ${NODE_ENV}`);
  console.log("🔓 Allowed origins:", allowedOrigins);
});
