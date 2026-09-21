import { BaseScraper } from "./base-scraper.js";
import { TripScraper } from "./trip-scraper.js";

export enum SupportedPlatforms {
  TRIP = 'trip'
}

export interface ScraperConfig {
  platform: SupportedPlatforms;
  jobId?: string;
  enableUI?: boolean;
  timeout?: number;
}

export class ScraperFactory {
  private static scrapers: Map<SupportedPlatforms, () => BaseScraper> = new Map([
    [SupportedPlatforms.TRIP, () => new TripScraper()]
  ]);

  static createScraper(config: ScraperConfig): BaseScraper {
    const scraperFactory = this.scrapers.get(config.platform);
    
    if (!scraperFactory) {
      throw new Error(`Unsupported platform: ${config.platform}. Supported platforms: ${Object.values(SupportedPlatforms).join(', ')}`);
    }

    const scraper = scraperFactory();
    
    // Apply configuration if needed
    if (config.jobId) {
      (scraper as any).jobId = config.jobId;
    }

    return scraper;
  }

  static getSupportedPlatforms(): SupportedPlatforms[] {
    return Array.from(this.scrapers.keys());
  }

  static isPlatformSupported(platform: string): boolean {
    return Object.values(SupportedPlatforms).includes(platform as SupportedPlatforms);
  }

  static registerScraper(platform: SupportedPlatforms, scraperFactory: () => BaseScraper): void {
    this.scrapers.set(platform, scraperFactory);
  }
}

// Utility function to determine platform from URL or identifier
export function detectPlatform(url: string): SupportedPlatforms | null {
  const urlLower = url.toLowerCase();

  if (urlLower.includes('trip.com') || urlLower.includes('ctrip')) {
    return SupportedPlatforms.TRIP;
  }

  return null;
}

// Export types for external use
export type { BaseScraper, ScrapingJobParams, ScrapingResult, LoginCredentials } from "./base-scraper.js";
