// backend-server-fixed.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

const PORT = Number(process.env.PORT || 4000);
const NODE_ENV = process.env.NODE_ENV || "development";
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS || 15000);
const TICK_RATE = Number(process.env.TICK_RATE || 60);
const RESPAWN_DELAY_MS = Number(process.env.RESPAWN_DELAY_MS || 1800);

// ---------------- CORS ----------------
const normalizeOrigin = (u) => (u ? String(u).trim().replace(/\/+$/, "") : u);

const clientOriginsFromEnv = String(CLIENT_URL)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5173",
  ...clientOriginsFromEnv,
]
  .map(normalizeOrigin)
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true;
  const o = normalizeOrigin(origin);
  if (NODE_ENV === "development") return true;
  if (allowedOrigins.includes(o)) return true;
  if (o.endsWith(".vercel.app")) return true;
  return false;
}

function corsOriginDelegate(origin, cb) {
  if (isOriginAllowed(origin)) return cb(null, true);
  console.log("❌ CORS blocked origin:", origin);
  console.log("✅ Allowed origins:", allowedOrigins);
  return cb(new Error("Not allowed by CORS"));
}

app.use(
  cors({
    origin: corsOriginDelegate,
    credentials: true,
  }),
);
app.use(express.json());

// ---------------- In-memory state ----------------
const rooms = new Map();
const playerToSocket = new Map();
const pendingDisconnects = new Map();

// ---------------- Health ----------------
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    env: NODE_ENV,
    uptime: process.uptime(),
    timestamp: Date.now(),
    rooms: rooms.size,
    players: playerToSocket.size,
    tickRate: TICK_RATE,
    allowedOrigins,
  });
});

app.get("/", (req, res) => res.json({ message: "Game Server Running" }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: corsOriginDelegate,
    credentials: true,
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ["websocket", "polling"],
});

// ---------------- Constants ----------------
const BASE_PHYSICS = {
  gravity: 0.6,
  moveSpeed: 5,
  jumpForce: -14,
  maxFallSpeed: 18,
  friction: 0.85,
};

// Match frontend sprite/collider dimensions
const PLAYER_WIDTH = 45;
const PLAYER_HEIGHT = 55;

// Separate world heights so map2 sits on visible ground (not floating)
const WORLD1_BASE_Y = 620;
const WORLD2_BASE_Y = Number(process.env.WORLD2_BASE_Y || 820);
const WORLD1_MAIN_FLOOR_Y = WORLD1_BASE_Y + 40;
const WORLD2_MAIN_FLOOR_Y = WORLD2_BASE_Y + 40;

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const sanitizeName = (v) =>
  String(v ?? "")
    .trim()
    .slice(0, 20);

function intersects(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

// ---------------- Worlds ----------------
function buildWorld1Platforms() {
  const gy = WORLD1_BASE_Y;
  return [
    { x: 0, y: gy + 40, width: 250, height: 20 },
    // Helper bridge to make map1 easier for all players.
    { x: 250, y: gy + 40, width: 5500, height: 20 },
    { x: 320, y: gy + 40, width: 60, height: 20 },
    { x: 450, y: gy + 40, width: 60, height: 20 },
    { x: 580, y: gy + 40, width: 60, height: 20 },
    { x: 710, y: gy + 40, width: 60, height: 20 },
    { x: 840, y: gy + 40, width: 80, height: 20 },
    { x: 1100, y: gy - 20, width: 100, height: 20 },
    { x: 1280, y: gy - 50, width: 80, height: 20 },
    { x: 1440, y: gy - 70, width: 80, height: 20 },
    { x: 1600, y: gy - 50, width: 80, height: 20 },
    { x: 1760, y: gy - 20, width: 100, height: 20 },
    { x: 2000, y: gy + 20, width: 50, height: 20 },
    { x: 2120, y: gy + 40, width: 50, height: 20 },
    { x: 2240, y: gy + 20, width: 50, height: 20 },
    { x: 2360, y: gy + 40, width: 50, height: 20 },
    { x: 2480, y: gy + 20, width: 50, height: 20 },
    { x: 2600, y: gy + 40, width: 50, height: 20 },
    { x: 2720, y: gy + 40, width: 120, height: 20 },
    { x: 3020, y: gy - 90, width: 100, height: 20 },
    { x: 3200, y: gy - 90, width: 100, height: 20 },
    { x: 3380, y: gy - 60, width: 80, height: 20 },
    { x: 3540, y: gy - 30, width: 80, height: 20 },
    { x: 3700, y: gy + 40, width: 60, height: 20 },
    { x: 3850, y: gy + 15, width: 60, height: 20 },
    { x: 3990, y: gy + 40, width: 60, height: 20 },
    { x: 4130, y: gy + 15, width: 60, height: 20 },
    { x: 4270, y: gy + 40, width: 60, height: 20 },
    { x: 4410, y: gy + 40, width: 150, height: 20 },
    { x: 4760, y: gy - 100, width: 120, height: 20 },
    { x: 4960, y: gy - 80, width: 80, height: 20 },
    { x: 5120, y: gy - 50, width: 80, height: 20 },
    { x: 5280, y: gy - 20, width: 80, height: 20 },
    { x: 5440, y: gy + 20, width: 100, height: 20 },
    { x: 5620, y: gy + 40, width: 200, height: 20 },
  ];
}

function buildWorld1MovingPlatforms() {
  return [];
}

function buildWorld1FallingPlatforms() {
  return [];
}

function buildWorld2Platforms(baseY = WORLD2_BASE_Y) {
  const gy = baseY;
  // Match frontend map2 world geometry
  return [{ x: 0, y: gy + 40, width: 8200, height: 20 }];
}

function buildWorld2DangerButtons(baseY = WORLD2_BASE_Y) {
  const gy = baseY;
  return [
    { x: 300, y: gy + 5, width: 40, height: 35 },
    { x: 530, y: gy + 5, width: 40, height: 35 },
    { x: 770, y: gy + 5, width: 40, height: 35 },
    { x: 1010, y: gy + 5, width: 40, height: 35 },
    { x: 1250, y: gy + 5, width: 40, height: 35 },
    { x: 1490, y: gy + 5, width: 40, height: 35 },
    { x: 1830, y: gy + 5, width: 40, height: 35 },
    { x: 2070, y: gy + 5, width: 40, height: 35 },
    { x: 2310, y: gy + 5, width: 40, height: 35 },
    { x: 2550, y: gy + 5, width: 40, height: 35 },
    { x: 2790, y: gy + 5, width: 40, height: 35 },
    { x: 3060, y: gy + 5, width: 40, height: 35 },
    { x: 3300, y: gy + 5, width: 40, height: 35 },
    { x: 3540, y: gy + 5, width: 40, height: 35 },
    { x: 3780, y: gy + 5, width: 40, height: 35 },
    { x: 4020, y: gy + 5, width: 40, height: 35 },
    { x: 4260, y: gy + 5, width: 40, height: 35 },
    { x: 4500, y: gy + 5, width: 40, height: 35 },
    { x: 4740, y: gy + 5, width: 40, height: 35 },
    { x: 4980, y: gy + 5, width: 40, height: 35 },
    { x: 5220, y: gy + 5, width: 40, height: 35 },
    { x: 5460, y: gy + 5, width: 40, height: 35 },
    { x: 5730, y: gy + 5, width: 40, height: 35 },
    { x: 5970, y: gy + 5, width: 40, height: 35 },
    { x: 6210, y: gy + 5, width: 40, height: 35 },
    { x: 6450, y: gy + 5, width: 40, height: 35 },
    { x: 6690, y: gy + 5, width: 40, height: 35 },
    { x: 6930, y: gy + 5, width: 40, height: 35 },
    { x: 7170, y: gy + 5, width: 40, height: 35 },
    { x: 7410, y: gy + 5, width: 40, height: 35 },
    { x: 7890, y: gy + 5, width: 40, height: 35 },
  ];
}

const WORLDS = {
  1: {
    id: 1,
    width: 6000,
    groundY: WORLD1_MAIN_FLOOR_Y,
    hasGlobalFloor: false,
    stopOnRelease: false,
    ...BASE_PHYSICS,
    friction: 1,
    platforms: buildWorld1Platforms(),
    movingPlatforms: buildWorld1MovingPlatforms(),
    fallingPlatforms: buildWorld1FallingPlatforms(),
    key: { x: 1950, y: 535, width: 40, height: 40 },
    door: { x: 3030, y: 525, width: 55, height: 75 },
    dangerButtons: [],
  },
  2: {
    id: 2,
    width: 8200,
    groundY: WORLD2_MAIN_FLOOR_Y,
    hasGlobalFloor: true,
    stopOnRelease: true,
    ...BASE_PHYSICS,
    platforms: buildWorld2Platforms(),
    movingPlatforms: [],
    fallingPlatforms: [],
    // FIX: use WORLD2_BASE_Y (frontend groundY), not WORLD2_MAIN_FLOOR_Y
    key: { x: 2400, y: WORLD2_BASE_Y - 220, width: 40, height: 40 },
    door: { x: 4400, y: WORLD2_BASE_Y - 80, width: 80, height: 120 },
    dangerButtons: buildWorld2DangerButtons(),
  },
};

function getWorld(worldId) {
  return WORLDS[Number(worldId)] || WORLDS[1];
}

function buildWorld2Runtime(baseY = WORLD2_BASE_Y) {
  const groundY = baseY + 40;
  return {
    id: 2,
    width: 8200,
    groundY,
    hasGlobalFloor: true,
    stopOnRelease: true,
    ...BASE_PHYSICS,
    platforms: buildWorld2Platforms(baseY),
    movingPlatforms: [],
    fallingPlatforms: [],
    key: { x: 2400, y: baseY - 220, width: 40, height: 40 },
    door: { x: 4400, y: baseY - 80, width: 80, height: 120 },
    dangerButtons: buildWorld2DangerButtons(baseY),
  };
}

function cloneWorldRuntime(worldId, options = {}) {
  const n = Number(worldId);
  if (n === 2) {
    const baseY = Number(options.world2BaseY);
    return buildWorld2Runtime(Number.isFinite(baseY) ? baseY : WORLD2_BASE_Y);
  }

  const w = getWorld(n);
  return {
    id: w.id,
    width: w.width,
    groundY: w.groundY,
    hasGlobalFloor: w.hasGlobalFloor,
    stopOnRelease: Boolean(w.stopOnRelease),
    gravity: w.gravity,
    moveSpeed: w.moveSpeed,
    jumpForce: w.jumpForce,
    maxFallSpeed: w.maxFallSpeed,
    friction: w.friction,
    platforms: w.platforms.map((p) => ({ ...p })),
    movingPlatforms: w.movingPlatforms.map((p) => ({ ...p })),
    fallingPlatforms: w.fallingPlatforms.map((p) => ({ ...p })),
    key: { ...w.key },
    door: { ...w.door },
    dangerButtons: w.dangerButtons.map((d) => ({ ...d })),
  };
}

// ---------------- Helpers ----------------
function clearPendingDisconnect(playerId) {
  const t = pendingDisconnects.get(playerId);
  if (t) {
    clearTimeout(t);
    pendingDisconnects.delete(playerId);
  }
}

function playerIndexOf(room, playerId) {
  return room.playerOrder.indexOf(playerId) + 1;
}

function createPlayerGameState(clientPlayerId, slot, room) {
  const colors = ["#FF6B6B", "#4ECDC4", "#FFE66D", "#A8DADC"];
  const firstPlatform = room.worldRuntime.platforms?.[0];
  const spawnY = firstPlatform
    ? firstPlatform.y - PLAYER_HEIGHT
    : room.worldRuntime.groundY - PLAYER_HEIGHT;

  return {
    id: slot,
    clientPlayerId,
    playerId: slot,
    hero: room.players[clientPlayerId]?.hero ?? null,
    name: room.players[clientPlayerId]?.name ?? "",
    x: 100 + (slot - 1) * 80,
    y: spawnY,
    vx: 0,
    vy: 0,
    width: PLAYER_WIDTH,
    height: PLAYER_HEIGHT,
    onGround: true,
    animFrame: 0,
    facingRight: true,
    color: colors[(slot - 1) % colors.length],
    dead: false,
    standingOnPlayer: null,
  };
}

function ensurePlayerState(room, playerId) {
  const slot = playerIndexOf(room, playerId);
  if (slot < 1) return null;

  if (!room.gameState.players[playerId]) {
    room.gameState.players[playerId] = createPlayerGameState(
      playerId,
      slot,
      room,
    );
  }

  const p = room.gameState.players[playerId];
  p.id = slot;
  p.playerId = slot;
  p.clientPlayerId = playerId;
  p.hero = room.players[playerId]?.hero ?? null;
  p.name = room.players[playerId]?.name ?? "";
  p.width = PLAYER_WIDTH;
  p.height = PLAYER_HEIGHT;
  p.x = clamp(p.x, 0, room.worldRuntime.width - p.width);
  if (!Number.isFinite(p.y)) p.y = room.worldRuntime.groundY - p.height;

  return p;
}

function allPicked(room) {
  return Object.values(room.players).every((p) => p.hero);
}

function allReady(room) {
  return Object.values(room.players).every((p) => p.ready);
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

function emitRoomState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  io.to(roomCode).emit("roomState", {
    roomCode: room.roomCode,
    maxPlayers: room.maxPlayers,
    hostId: room.hostId,
    started: room.started,
    world: room.world,
    players: room.players,
  });
}

function emitGameState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const world = room.worldRuntime;
  const players = {};

  for (const pid of room.playerOrder) {
    if (!room.players[pid]) continue;
    players[pid] = ensurePlayerState(room, pid);
  }

  room.gameState.players = players;

  io.to(roomCode).emit("gameState", {
    players: room.gameState.players,
    keyCollected: Boolean(room.gameState.keyCollected),
    playersAtDoor: Array.isArray(room.gameState.playersAtDoor)
      ? room.gameState.playersAtDoor
      : [],
    gameStatus: room.started
      ? room.gameState.gameStatus || "playing"
      : "waiting",
    world: room.world,
    key: world.key,
    door: world.door,
    dangerButtons: world.dangerButtons,
    movingPlatforms: world.movingPlatforms,
    fallingPlatforms: world.fallingPlatforms,
  });
}

// ---------------- Simulation ----------------
function parseInputPayload(payload) {
  const raw = payload?.input ?? payload?.keys ?? payload ?? {};
  return {
    left: Boolean(raw.left),
    right: Boolean(raw.right),
    jump: Boolean(raw.jump),
  };
}

function resolvePlayerCollisions(room, selfId) {
  const self = room.gameState.players[selfId];
  if (!self) return;

  self.standingOnPlayer = null;

  for (const [otherId, other] of Object.entries(room.gameState.players)) {
    if (otherId === selfId || !other || other.dead) continue;
    if (!intersects(self, other)) continue;

    const overlapX1 = self.x + self.width - other.x;
    const overlapX2 = other.x + other.width - self.x;
    const overlapY1 = self.y + self.height - other.y;
    const overlapY2 = other.y + other.height - self.y;

    const minOverlapX = Math.min(overlapX1, overlapX2);
    const minOverlapY = Math.min(overlapY1, overlapY2);

    if (minOverlapX < minOverlapY) {
      // Side collision: only resolve self to avoid double-pushing states.
      if (self.x < other.x) self.x -= minOverlapX;
      else self.x += minOverlapX;
      self.x = clamp(self.x, 0, room.worldRuntime.width - self.width);
      self.vx = 0;
      continue;
    }

    const selfPrevY = Number.isFinite(self.prevY) ? self.prevY : self.y;
    const otherPrevY = Number.isFinite(other.prevY) ? other.prevY : other.y;
    const selfBottom = self.y + self.height;
    const otherBottom = other.y + other.height;
    const selfPrevBottom = selfPrevY + self.height;
    const otherPrevBottom = otherPrevY + other.height;

    // One-way stacking: landing player stays on top, support player won't sink.
    const landingOnOther =
      self.vy >= 0 &&
      self.y < other.y &&
      selfPrevBottom <= other.y + 12 &&
      selfBottom >= other.y;

    if (landingOnOther) {
      self.y = other.y - self.height;
      self.vy = 0;
      self.onGround = true;
      self.standingOnPlayer = Number(other.id ?? otherId) || otherId;
      continue;
    }

    // Hitting underside while jumping.
    const hittingUnderOther =
      self.vy < 0 && selfPrevY >= otherPrevBottom - 8 && self.y <= otherBottom;
    if (hittingUnderOther) {
      self.y = otherBottom;
      self.vy = 0;
      continue;
    }

    // Favor stable one-way stacking: do not push the lower player downward.
    if (self.y < other.y) {
      self.y = other.y - self.height;
      self.vy = 0;
      self.onGround = true;
      self.standingOnPlayer = Number(other.id ?? otherId) || otherId;
    }
  }
}

function updateWorldRuntime(room, dtScale) {
  const world = room.worldRuntime;

  world.movingPlatforms.forEach((mp) => {
    const prevX = mp.x;
    mp.x += mp.speed * mp.direction * dtScale;
    if (mp.x <= mp.startX || mp.x >= mp.endX) {
      mp.direction *= -1;
      mp.x = clamp(mp.x, mp.startX, mp.endX);
    }
    mp.deltaX = mp.x - prevX;
  });

  world.fallingPlatforms.forEach((fp) => {
    if (fp.falling) {
      fp.fallTimer += dtScale;
      if (fp.fallTimer > 30) fp.y += 8 * dtScale;
    }
  });
}

function platformListForCollisions(world) {
  const visibleFalling = world.fallingPlatforms.filter(
    (fp) => fp.y < world.groundY + 300,
  );
  return [...world.platforms, ...world.movingPlatforms, ...visibleFalling];
}

function movingPlatformUnderPlayer(world, player) {
  const playerBottom = player.y + player.height;
  return world.movingPlatforms.find((mp) => {
    // Be tolerant to small server tick drift so carry stays stable.
    const standingOnTop =
      playerBottom >= mp.y - 8 && playerBottom <= mp.y + 10 && player.vy >= -1;
    const horizontalOverlap =
      player.x + player.width > mp.x + 2 && player.x < mp.x + mp.width - 2;
    return standingOnTop && horizontalOverlap;
  });
}

function applyPlayerStep(room, playerId, dtScale) {
  const world = room.worldRuntime;
  const player = ensurePlayerState(room, playerId);
  if (!player || player.dead) return;

  const input = room.inputs[playerId] || {
    left: false,
    right: false,
    jump: false,
  };

  if (input.left) {
    player.vx = -world.moveSpeed;
    player.facingRight = false;
    player.animFrame = (player.animFrame + 1) % 4;
  } else if (input.right) {
    player.vx = world.moveSpeed;
    player.facingRight = true;
    player.animFrame = (player.animFrame + 1) % 4;
  } else {
    if (world.stopOnRelease && player.onGround) {
      player.vx = 0;
    } else {
      player.vx *= Math.pow(world.friction, dtScale);
      if (Math.abs(player.vx) < 0.1) player.vx = 0;
    }
    player.animFrame = 0;
  }

  if (input.jump && player.onGround) {
    player.vy = world.jumpForce;
    player.onGround = false;
  }

  const plats = platformListForCollisions(world);

  // Horizontal
  const prevX = player.x;
  player.x += player.vx * dtScale;
  player.x = clamp(player.x, 0, world.width - player.width);

  for (const plat of plats) {
    if (!intersects(player, plat)) continue;
    if (player.vx > 0) player.x = plat.x - player.width;
    else if (player.vx < 0) player.x = plat.x + plat.width;
    else player.x = prevX;
    player.vx = 0;
  }

  // Vertical
  const prevY = player.y;
  player.prevY = prevY;
  const prevBottom = prevY + player.height;
  player.vy += world.gravity * dtScale;
  player.vy = Math.min(player.vy, world.maxFallSpeed);
  player.y += player.vy * dtScale;
  player.onGround = false;

  for (const plat of plats) {
    if (!intersects(player, plat)) continue;

    const currBottom = player.y + player.height;
    const platTop = plat.y;
    const platBottom = plat.y + plat.height;

    if (prevBottom <= platTop && currBottom >= platTop && player.vy >= 0) {
      player.y = platTop - player.height;
      player.vy = 0;
      player.onGround = true;

      if ("falling" in plat && !plat.falling) {
        plat.falling = true;
        plat.fallTimer = 0;
      }
      continue;
    }

    if (prevY >= platBottom && player.y <= platBottom && player.vy < 0) {
      player.y = platBottom;
      player.vy = 0;
    }
  }

  if (world.hasGlobalFloor && player.y + player.height >= world.groundY) {
    player.y = world.groundY - player.height;
    player.vy = 0;
    player.onGround = true;
  }

  const carrier = movingPlatformUnderPlayer(world, player);
  if (player.onGround && carrier && Number.isFinite(carrier.deltaX)) {
    player.x += carrier.deltaX;
    player.x = clamp(player.x, 0, world.width - player.width);
  }

  if (player.y > world.groundY + 300) {
    player.dead = true;
    room.gameState.gameStatus = "dead";
    room.deadUntil = Date.now() + RESPAWN_DELAY_MS;
  }

  resolvePlayerCollisions(room, playerId);
}

function resetRoundAfterDeath(room) {
  room.worldRuntime = cloneWorldRuntime(room.world, {
    world2BaseY: room.world2BaseY,
  });
  room.gameState.keyCollected = false;
  room.gameState.playersAtDoor = [];
  room.gameState.gameStatus = "playing";

  for (const pid of room.playerOrder) {
    if (!room.players[pid]) continue;
    const slot = playerIndexOf(room, pid);
    room.gameState.players[pid] = createPlayerGameState(pid, slot, room);
  }

  room.deadUntil = 0;
}

function evaluateGameState(room) {
  const now = Date.now();

  if (room.gameState.gameStatus === "dead") {
    if (room.deadUntil && now >= room.deadUntil) {
      resetRoundAfterDeath(room);
    }
    return;
  }

  const world = room.worldRuntime;
  const players = room.gameState.players;
  const playerIds = room.playerOrder.filter((pid) => room.players[pid]);

  if (!room.gameState.keyCollected) {
    for (const pid of playerIds) {
      const p = players[pid];
      if (p && !p.dead && intersects(p, world.key)) {
        room.gameState.keyCollected = true;
        break;
      }
    }
  }

  if (room.world === 2) {
    for (const pid of playerIds) {
      const p = players[pid];
      if (!p || p.dead) continue;
      const touchedDanger = world.dangerButtons.some((b) => intersects(p, b));
      if (touchedDanger) {
        room.gameState.gameStatus = "dead";
        room.deadUntil = Date.now() + RESPAWN_DELAY_MS;
        return;
      }
    }
  }

  if (room.gameState.keyCollected) {
    const atDoor = [];
    for (const pid of playerIds) {
      const p = players[pid];
      if (!p || p.dead) continue;
      if (intersects(p, world.door)) atDoor.push(pid);
    }

    room.gameState.playersAtDoor = atDoor.map(
      (pid) => Number(players[pid]?.id) || 0,
    );

    if (playerIds.length > 0 && atDoor.length === playerIds.length) {
      room.gameState.gameStatus = "won";
      return;
    }
  }

  room.gameState.gameStatus = "playing";
}

function stepRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || !room.started) return;

  const now = Date.now();
  const frameMs = 1000 / TICK_RATE;
  const elapsedMs = room.lastStepAt ? now - room.lastStepAt : frameMs;
  room.lastStepAt = now;

  const dtScale = clamp(elapsedMs / frameMs, 0.5, 2.5);

  updateWorldRuntime(room, dtScale);

  for (const pid of room.playerOrder) {
    if (!room.players[pid]) continue;
    applyPlayerStep(room, pid, dtScale);
  }

  evaluateGameState(room);
  emitGameState(roomCode);
}

function startRoomLoop(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (room.loopHandle) return;

  room.lastStepAt = Date.now();
  const tickMs = Math.max(10, Math.floor(1000 / TICK_RATE));
  room.loopHandle = setInterval(() => stepRoom(roomCode), tickMs);
}

function stopRoomLoop(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || !room.loopHandle) return;
  clearInterval(room.loopHandle);
  room.loopHandle = null;
}

function normalizeWorldValue(value) {
  const s = String(value ?? "")
    .toLowerCase()
    .trim();
  if (s === "2" || s === "map2" || s === "world2") return 2;
  return 1;
}

function normalizeWorld2BaseYFromPayload(payload) {
  const rawHeight = Number(
    payload?.canvasHeight ?? payload?.viewportHeight ?? payload?.height,
  );
  if (!Number.isFinite(rawHeight) || rawHeight < 100) return null;
  const baseY = Math.round(rawHeight) - 80;
  return clamp(baseY, 500, 1400);
}

function syncRoomWorld2Height(room, payload) {
  if (!room || room.world !== 2) return;

  const nextBaseY = normalizeWorld2BaseYFromPayload(payload);
  if (!Number.isFinite(nextBaseY)) return;

  const prevBaseY = Number.isFinite(room.world2BaseY)
    ? room.world2BaseY
    : WORLD2_BASE_Y;

  if (Math.abs(nextBaseY - prevBaseY) < 2) return;

  const prevGroundY = room.worldRuntime?.groundY ?? prevBaseY + 40;
  room.world2BaseY = nextBaseY;
  room.worldRuntime = cloneWorldRuntime(2, { world2BaseY: room.world2BaseY });

  const nextGroundY = room.worldRuntime.groundY;
  const deltaY = nextGroundY - prevGroundY;

  for (const p of Object.values(room.gameState.players || {})) {
    if (!p) continue;
    p.y += deltaY;
    p.x = clamp(p.x, 0, room.worldRuntime.width - p.width);
    if (p.y + p.height >= nextGroundY) {
      p.y = nextGroundY - p.height;
      p.vy = 0;
      p.onGround = true;
    }
  }
}

function applyWorldSelection(roomCode, playerId, requestedWorld) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (room.hostId !== playerId) return;

  const worldNum = normalizeWorldValue(requestedWorld);
  room.world = worldNum;
  room.worldRuntime = cloneWorldRuntime(worldNum, {
    world2BaseY: room.world2BaseY,
  });

  room.gameState = {
    players: {},
    keyCollected: false,
    playersAtDoor: [],
    gameStatus: room.started ? "playing" : "waiting",
    world: worldNum,
  };
  room.inputs = {};
  room.deadUntil = 0;

  emitRoomState(roomCode);
  emitGameState(roomCode);
}

// ---------------- Socket ----------------
io.on("connection", (socket) => {
  console.log("✅ Socket connected:", socket.id);

  socket.on(
    "createRoom",
    ({
      roomCode,
      maxPlayers,
      hostId,
      playerName,
      world,
      level,
      ...payload
    }) => {
      try {
        const max = Number(maxPlayers);
        const name = sanitizeName(playerName);
        const initialWorld = normalizeWorldValue(level ?? world);
        const initialWorld2BaseY =
          initialWorld === 2
            ? (normalizeWorld2BaseYFromPayload(payload) ?? WORLD2_BASE_Y)
            : WORLD2_BASE_Y;

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
          world: initialWorld,
          world2BaseY: initialWorld2BaseY,
          worldRuntime: cloneWorldRuntime(initialWorld, {
            world2BaseY: initialWorld2BaseY,
          }),
          playerOrder: [hostId],
          players: {
            [hostId]: { hero: null, ready: false, name: name || "Player 1" },
          },
          gameState: {
            players: {},
            keyCollected: false,
            playersAtDoor: [],
            gameStatus: "waiting",
            world: initialWorld,
          },
          inputs: {},
          loopHandle: null,
          lastStepAt: 0,
          deadUntil: 0,
        };

        rooms.set(roomCode, room);

        socket.join(roomCode);
        socket.data.roomCode = roomCode;
        socket.data.playerId = hostId;

        if (!playerToSocket.has(hostId)) playerToSocket.set(hostId, new Set());
        playerToSocket.get(hostId).add(socket.id);

        emitRoomState(roomCode);
        emitGameState(roomCode);

        socket.emit("joinSuccess", {
          roomCode,
          playerId: hostId,
          playerIndex: 1,
          message: "Host created room",
        });
      } catch (e) {
        console.error("createRoom error:", e);
        socket.emit("createDenied", "Server error");
      }
    },
  );

  socket.on("setWorld", ({ world }) => {
    try {
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) return;
      applyWorldSelection(roomCode, playerId, world);
    } catch (e) {
      console.error("setWorld error:", e);
    }
  });

  // Alias for frontend that emits setLevel with map1/map2
  socket.on("setLevel", ({ level, world }) => {
    try {
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) return;
      applyWorldSelection(roomCode, playerId, level ?? world);
    } catch (e) {
      console.error("setLevel error:", e);
    }
  });

  socket.on("joinRoom", ({ roomCode, playerId, name }) => {
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

      if (room.started && !room.players[playerId]) {
        socket.emit("joinDenied", { message: "Game already started" });
        return;
      }

      if (room.players[playerId]) {
        disconnectPlayerSocketsOnly(playerId, roomCode);
      }

      const count = Object.keys(room.players).length;
      if (!room.players[playerId] && count >= room.maxPlayers) {
        socket.emit("joinDenied", { message: "Room full" });
        return;
      }

      const cleanName = sanitizeName(name);

      if (!room.players[playerId]) {
        room.players[playerId] = {
          hero: null,
          ready: false,
          name: cleanName || `Player ${count + 1}`,
        };
        room.playerOrder.push(playerId);
      } else if (cleanName) {
        room.players[playerId].name = cleanName;
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
        playerId,
        playerIndex: playerIndexOf(room, playerId),
        message: "Successfully joined room",
      });
    } catch (e) {
      console.error("joinRoom error:", e);
      socket.emit("joinDenied", { message: "Server error" });
    }
  });

  socket.on("setPlayerName", ({ name }) => {
    try {
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) return;

      const room = rooms.get(roomCode);
      if (!room || !room.players[playerId]) return;

      const clean = sanitizeName(name);
      if (!clean) return;

      room.players[playerId].name = clean;
      if (room.gameState.players[playerId]) {
        room.gameState.players[playerId].name = clean;
      }

      emitRoomState(roomCode);
      emitGameState(roomCode);
    } catch (e) {
      console.error("setPlayerName error:", e);
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

      ensurePlayerState(room, playerId);
      emitRoomState(roomCode);
      emitGameState(roomCode);
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
      room.worldRuntime = cloneWorldRuntime(room.world, {
        world2BaseY: room.world2BaseY,
      });
      room.gameState = {
        players: {},
        keyCollected: false,
        playersAtDoor: [],
        gameStatus: "playing",
        world: room.world,
      };
      room.deadUntil = 0;

      io.to(roomCode).emit("startGame");
      emitRoomState(roomCode);
      emitGameState(roomCode);
      startRoomLoop(roomCode);
    } catch (e) {
      console.error("startGameNow error:", e);
      socket.emit("startDenied", { message: "Server error" });
    }
  });

  const updateInput = (payload) => {
    try {
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) return;

      const room = rooms.get(roomCode);
      if (!room || !room.started) return;

      syncRoomWorld2Height(room, payload);
      room.inputs[playerId] = parseInputPayload(payload);
    } catch (e) {
      console.error("playerInput error:", e);
    }
  };

  socket.on("playerInput", updateInput);
  socket.on("playerMove", updateInput);

  socket.on("disconnect", () => {
    try {
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) return;

      const sockets = playerToSocket.get(playerId);
      if (!sockets) return;

      sockets.delete(socket.id);
      if (sockets.size > 0) return;

      playerToSocket.delete(playerId);
      clearPendingDisconnect(playerId);

      const timer = setTimeout(() => {
        pendingDisconnects.delete(playerId);

        const room = rooms.get(roomCode);
        if (!room) return;
        if (playerToSocket.has(playerId)) return;
        if (!room.players[playerId]) return;

        delete room.players[playerId];
        delete room.inputs[playerId];
        if (room.gameState.players[playerId]) {
          delete room.gameState.players[playerId];
        }
        room.playerOrder = room.playerOrder.filter((x) => x !== playerId);

        if (Object.keys(room.players).length === 0) {
          stopRoomLoop(roomCode);
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
  console.log("🔧 CLIENT_URL env:", CLIENT_URL);
});
