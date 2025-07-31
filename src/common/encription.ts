import * as crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const algorithm = 'aes-256-gcm';
const secretKey = process.env.ENCRYPTION_KEY;

export function decrypt(encryptedData: {
  encrypted: string;
  iv: string;
  authTag: string;
}): string {
  try {
    const { encrypted, iv, authTag } = encryptedData;

    // Create decipher with IV
    if (!secretKey) {
      throw new Error('ENCRYPTION_KEY environment variable is not set');
    }
    
    const decipher = crypto.createDecipheriv(
      algorithm,
      Buffer.from(secretKey),
      Buffer.from(iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));

    // Decrypt the text
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    throw new Error(`Decryption failed`);
  }
}

export function encrypt(text: string): {
  encrypted: string;
  iv: string;
  authTag: string;
} {
  try {
    if (!secretKey) {
      throw new Error('ENCRYPTION_KEY environment variable is not set');
    }

    // Generate random IV
    const iv = crypto.randomBytes(16);
    
    // Create cipher
    const cipher = crypto.createCipheriv(algorithm, Buffer.from(secretKey), iv);
    
    // Encrypt the text
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // Get auth tag
    const authTag = cipher.getAuthTag();

    return {
      encrypted,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex')
    };
  } catch (error) {
    throw new Error(`Encryption failed: ${error}`);
  }
}

export function encryptPassword(password: string): string {
  try {
    const encryptedData = encrypt(password);
    return JSON.stringify(encryptedData);
  } catch (error) {
    throw new Error(`Failed to encrypt password: ${error}`);
  }
}

export function decryptPassword(encryptedPasswordJson: string | undefined | null): string {
  try {
    if (!encryptedPasswordJson) {
      throw new Error('Encrypted password is not provided');
    }
    const encryptedData = JSON.parse(encryptedPasswordJson);
    return decrypt(encryptedData);
  } catch (error) {
    throw new Error(`Failed to decrypt password`);
  }
}