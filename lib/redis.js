// Shared Redis client for the app.
//
// Moved here from routes/meeting.js when the MCP server was added so the
// meeting routes, the MCP routes and the MCP token store all share one
// client (and one reconnection policy) instead of each opening their own.
//
// Connection target: REDIS_URL (or REDIS_HOST) env, default 127.0.0.1:6379.
// A missing Redis is non-fatal at boot: operations fail only when they run
// (ensureRedisConnection() throws), same behaviour as before the move.

const redis = require("redis");

let redisSource = process.env.REDIS_URL || process.env.REDIS_HOST || "127.0.0.1";
let client;
let isConnecting = false;

// Reconnection strategy for both URL and hostname connections
const reconnectStrategy = (retries) => {
  if (retries > 10) {
    console.error("Redis reconnection failed after 10 attempts");
    return new Error("Redis reconnection failed");
  }
  // Exponential backoff with jitter
  const delay = Math.min(retries * 50, 2000) + Math.random() * 1000;
  console.log(`Redis reconnecting in ${Math.round(delay)}ms (attempt ${retries + 1})`);
  return delay;
};

// Create Redis client based on connection type
if (redisSource.startsWith("redis://") || redisSource.startsWith("rediss://")) {
  // Full URL with credentials - FIXED: use 'url' property
  client = redis.createClient({
    url: redisSource,
    socket: {
      reconnectStrategy: reconnectStrategy
    }
  });
  console.log("Using Redis URL:", redisSource);
} else {
  // Just a hostname
  console.log("Using Redis host:", redisSource);
  client = redis.createClient({
    socket: {
      host: redisSource,
      port: process.env.REDIS_PORT || 6379,
      reconnectStrategy: reconnectStrategy
    }
  });
}

// Enhanced connection function with retry logic
async function connectToRedis() {
  if (isConnecting || client.isOpen) {
    return;
  }

  isConnecting = true;
  try {
    await client.connect();
    console.log("Connected to Redis successfully");
    isConnecting = false;
  } catch (err) {
    console.error("Failed to connect to Redis:", err.message);
    isConnecting = false;
    // Retry connection after delay
    setTimeout(() => {
      console.log("Retrying Redis connection...");
      connectToRedis();
    }, 5000);
  }
}

// Ensure client is connected for all connection types
connectToRedis();

function maskRedis(ref) {
  try {
    const u = new URL(ref);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return ref;
  }
}

// Enhanced Redis event handling
client.on('error', (err) => {
  console.error("Redis connection error:", err.message);
});

client.on('connect', () => {
  console.log("Redis client connected");
});

client.on('ready', () => {
  console.log("Redis client ready to receive commands");
});

client.on('end', () => {
  console.log("Redis connection closed");
});

client.on('reconnecting', () => {
  console.log("Redis client reconnecting...");
});

// Helper function to ensure Redis connection before operations
async function ensureRedisConnection() {
  if (!client.isOpen && !isConnecting) {
    console.log("Redis not connected, attempting to connect...");
    await connectToRedis();
  }

  // Wait a bit if still connecting
  let attempts = 0;
  while (isConnecting && attempts < 10) {
    await new Promise(resolve => setTimeout(resolve, 100));
    attempts++;
  }

  if (!client.isOpen) {
    throw new Error("Redis connection not available");
  }
}

// Log (sanitized) connection target once
console.log("Connecting to Redis:", maskRedis(redisSource));

module.exports = { client, ensureRedisConnection };
