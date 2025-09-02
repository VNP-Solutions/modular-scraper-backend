import { ICookieStorage, CookieStorage } from "../models/cookie-storage.model.js";
import { encrypt, decrypt } from "../common/encription.js";
import { dualLogInfo, dualLogError } from "../common/log-helper.js";
import { PlatformsType } from "../common/booking-error-types.js";

export interface CookieData {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export class CookieStorageService {
  /**
   * Save cookies for a specific property and platform
   */
  async saveCookies(
    propertyId: string, 
    platform: PlatformsType, 
    cookies: CookieData[]
  ): Promise<ICookieStorage | null> {
    try {
      await dualLogInfo(`Saving ${cookies.length} cookies for property ${propertyId} on platform ${platform}`);

      // Encrypt the cookies data
      const cookiesJson = JSON.stringify(cookies);
      const encryptedData = encrypt(cookiesJson);
      const encryptedString = JSON.stringify(encryptedData);

      // Calculate expiration time (use the latest cookie expiration or 30 days from now)
      const expirationTimes = cookies
        .map(cookie => cookie.expires)
        .filter(exp => exp && exp > 0)
        .map(exp => new Date(exp! * 1000));
      
      const expiresAt = expirationTimes.length > 0 
        ? new Date(Math.max(...expirationTimes.map(date => date.getTime())))
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days from now

      // Upsert the cookie storage record
      const cookieStorage = await CookieStorage.findOneAndUpdate(
        { property_id: propertyId, platform },
        {
          $set: {
            cookies_data: encryptedString,
            expires_at: expiresAt,
            last_used: new Date(),
            is_active: true,
            updatedAt: new Date()
          }
        },
        { 
          upsert: true, 
          new: true,
          setDefaultsOnInsert: true
        }
      );

      await dualLogInfo(`Successfully saved cookies for property ${propertyId} on platform ${platform}`);
      return cookieStorage;

    } catch (error) {
      await dualLogError(`Failed to save cookies for property ${propertyId} on platform ${platform}:`, error);
      return null;
    }
  }

  /**
   * Load cookies for a specific property and platform
   */
  async loadCookies(propertyId: string, platform: PlatformsType): Promise<CookieData[] | null> {
    try {
      await dualLogInfo(`Loading cookies for property ${propertyId} on platform ${platform}`);

      const cookieStorage = await CookieStorage.findOne({
        property_id: propertyId,
        platform,
        is_active: true,
        $or: [
          { expires_at: { $exists: false } },
          { expires_at: null },
          { expires_at: { $gt: new Date() } }
        ]
      });

      if (!cookieStorage) {
        await dualLogInfo(`No active cookies found for property ${propertyId} on platform ${platform}`);
        return null;
      }

      // Decrypt the cookies data
      const encryptedData = JSON.parse(cookieStorage.cookies_data);
      const decryptedJson = decrypt(encryptedData);
      const cookies: CookieData[] = JSON.parse(decryptedJson);

      // Update last_used timestamp
      await CookieStorage.updateOne(
        { _id: cookieStorage._id },
        { $set: { last_used: new Date() } }
      );

      await dualLogInfo(`Successfully loaded ${cookies.length} cookies for property ${propertyId} on platform ${platform}`);
      return cookies;

    } catch (error) {
      await dualLogError(`Failed to load cookies for property ${propertyId} on platform ${platform}:`, error);
      return null;
    }
  }

  /**
   * Delete cookies for a specific property and platform
   */
  async deleteCookies(propertyId: string, platform: PlatformsType): Promise<boolean> {
    try {
      await dualLogInfo(`Deleting cookies for property ${propertyId} on platform ${platform}`);

      const result = await CookieStorage.deleteOne({
        property_id: propertyId,
        platform
      });

      const success = result.deletedCount > 0;
      
      if (success) {
        await dualLogInfo(`Successfully deleted cookies for property ${propertyId} on platform ${platform}`);
      } else {
        await dualLogInfo(`No cookies found to delete for property ${propertyId} on platform ${platform}`);
      }

      return success;

    } catch (error) {
      await dualLogError(`Failed to delete cookies for property ${propertyId} on platform ${platform}:`, error);
      return false;
    }
  }

  /**
   * Check if valid cookies exist for a property and platform
   */
  async hasValidCookies(propertyId: string, platform: PlatformsType): Promise<boolean> {
    try {
      const count = await CookieStorage.countDocuments({
        property_id: propertyId,
        platform,
        is_active: true,
        $or: [
          { expires_at: { $exists: false } },
          { expires_at: null },
          { expires_at: { $gt: new Date() } }
        ]
      });

      return count > 0;

    } catch (error) {
      await dualLogError(`Failed to check cookies for property ${propertyId} on platform ${platform}:`, error);
      return false;
    }
  }
}

// Export singleton instance
export const cookieStorageService = new CookieStorageService(); 