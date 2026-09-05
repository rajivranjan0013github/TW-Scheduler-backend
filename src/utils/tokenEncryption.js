import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Returns the encryption key from env, or null if not configured.
 * When null, encryption is disabled (tokens stored in plaintext).
 */
const getEncryptionKey = () => {
  const key = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;
  if (!key) return null;
  // Accept 64-char hex string (32 bytes) or 32-char raw key
  if (key.length === 64) return Buffer.from(key, 'hex');
  if (key.length === 32) return Buffer.from(key, 'utf8');
  throw new Error('SOCIAL_TOKEN_ENCRYPTION_KEY must be exactly 32 bytes (or 64 hex characters).');
};

/**
 * Encrypts a plaintext token using AES-256-GCM.
 * Returns a base64 string in the format: iv:ciphertext:authTag
 * If encryption key is not configured, returns the plaintext as-is.
 */
export const encryptToken = (plaintext) => {
  if (!plaintext) return plaintext;
  const key = getEncryptionKey();
  if (!key) return plaintext;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `enc:${iv.toString('base64')}:${encrypted.toString('base64')}:${authTag.toString('base64')}`;
};

/**
 * Decrypts an encrypted token string.
 * If the value doesn't start with 'enc:', it's treated as plaintext (backwards compatible).
 * If encryption key is not configured but value is encrypted, throws.
 */
export const decryptToken = (encryptedValue) => {
  if (!encryptedValue) return encryptedValue;
  if (!encryptedValue.startsWith('enc:')) return encryptedValue; // plaintext, backwards compatible

  const key = getEncryptionKey();
  if (!key) {
    throw new Error('Cannot decrypt token: SOCIAL_TOKEN_ENCRYPTION_KEY is not configured.');
  }

  const parts = encryptedValue.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted token format.');
  }

  const [, ivB64, ciphertextB64, authTagB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return decrypted.toString('utf8');
};

/**
 * Check if encryption is enabled (key is configured).
 */
export const isEncryptionEnabled = () => {
  return getEncryptionKey() !== null;
};
