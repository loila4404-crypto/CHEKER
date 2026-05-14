const crypto = require("crypto");

function getKey(secret) {
  return crypto
    .createHash("sha256")
    .update(secret)
    .digest();
}

function encryptBuffer(buffer, secret) {
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    getKey(secret),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(buffer),
    cipher.final()
  ]);

  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]);
}

function decryptBuffer(buffer, secret) {
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const encrypted = buffer.subarray(28);

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getKey(secret),
    iv
  );

  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ]);
}

module.exports = {
  encryptBuffer,
  decryptBuffer
};