const { connection } = require("./queue");
const { encrypt, decrypt } = require("./crypto");

const TTL = 2 * 60 * 60; // 2h — conservador; si Zajuna expira antes, el worker detecta el redirect

async function saveSession(userId, storageState) {
  const json = JSON.stringify(storageState);
  const encrypted = encrypt(json);
  await connection.set(`session:${userId}`, encrypted, "EX", TTL);
}

async function loadSession(userId) {
  const encrypted = await connection.get(`session:${userId}`);
  if (!encrypted) return null;
  try {
    const json = decrypt(encrypted);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

module.exports = { saveSession, loadSession };
