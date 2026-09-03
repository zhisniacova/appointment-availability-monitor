const crypto = require("node:crypto");

const VERSION = "v1";
const IV_BYTES = 12;

function createCryptoBox(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("createCryptoBox requires a 32-byte key");
  }

  function encrypt(value) {
    if (typeof value !== "string") {
      throw new TypeError("Encrypted values must be strings");
    }

    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      VERSION,
      iv.toString("base64url"),
      tag.toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(":");
  }

  function decrypt(payload) {
    if (!payload) {
      return "";
    }

    const [version, ivText, tagText, ciphertextText] = String(payload).split(":");
    if (version !== VERSION || !ivText || !tagText || !ciphertextText) {
      throw new Error("Unsupported encrypted payload format");
    }

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64url")),
      decipher.final(),
    ]);

    return plaintext.toString("utf8");
  }

  return {
    encrypt,
    decrypt,
  };
}

module.exports = {
  createCryptoBox,
};
