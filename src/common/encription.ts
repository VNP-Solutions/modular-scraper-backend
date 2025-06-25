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