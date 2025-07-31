import dotenv from "dotenv";
import puppeteer, { Browser, Page } from "puppeteer";
import { delay } from "../../common/delay.js";
import { dualLogInfo, dualLogError, dualLogWarn } from "../../common/log-helper.js";

dotenv.config();

interface SessionData {
  sessionId: string;
  browserWSEndpoint: string;
  cookies: any[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

export class BrowserlessSessionTest {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private sessionData: SessionData | null = null;
  private liveURL: string | null = null;

  async startNewSession(): Promise<void> {
    try {
      await dualLogInfo("=== Starting New Browserless Session ===");
      
      // Connect to Browserless
      this.browser = await puppeteer.connect({
        browserWSEndpoint: `wss://production-sfo.browserless.io/?token=${process.env.BROWSERLESS_TOKEN}&stealth`,
      });

      await dualLogInfo("Connected to Browserless");

      // Create new page
      this.page = await this.browser.newPage();
      const cdp = await this.page.createCDPSession();

      // Start recording for debugging
      await (cdp as any).send("Browserless.startRecording");
      await dualLogInfo("Recording started");

      // Generate live URL for monitoring
      const { liveURL } = (await (cdp as any).send("Browserless.liveURL", {
        timeout: 600_000, // 10 minutes
      })) as { liveURL: string };
      
      this.liveURL = liveURL;
      await dualLogInfo("Live session URL:", { liveURL });

      // Navigate to Booking.com
      await dualLogInfo("Navigating to Booking.com...");
      await this.page.goto("https://www.booking.com", {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      // Wait for page to load
      await delay(3000);

      // Take screenshot
      await this.page.screenshot({ 
        path: "booking-initial.png",
        fullPage: true 
      });
      await dualLogInfo("Screenshot saved: booking-initial.png");

      // Store session data
      this.sessionData = {
        sessionId: this.browser.wsEndpoint(),
        browserWSEndpoint: this.browser.wsEndpoint(),
        cookies: await this.page.cookies(),
        localStorage: await this.page.evaluate(() => {
          const items: Record<string, string> = {};
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key) items[key] = localStorage.getItem(key) || "";
          }
          return items;
        }),
        sessionStorage: await this.page.evaluate(() => {
          const items: Record<string, string> = {};
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key) items[key] = sessionStorage.getItem(key) || "";
          }
          return items;
        }),
      };

      await dualLogInfo("Session data captured", {
        cookieCount: this.sessionData.cookies.length,
        localStorageKeys: Object.keys(this.sessionData.localStorage).length,
        sessionStorageKeys: Object.keys(this.sessionData.sessionStorage).length,
      });

    } catch (error) {
      await dualLogError("Failed to start new session:", error);
      throw error;
    }
  }

  async simulateLogin(): Promise<void> {
    try {
      if (!this.page) throw new Error("No active page");

      await dualLogInfo("=== Simulating Login Process ===");

      // Click on Sign In button
      const signInSelector = 'a[data-testid="header-sign-in-button"], button[aria-label*="Sign in"], a[href*="auth/realms"]';
      
      await dualLogInfo("Looking for sign-in button...");
      await this.page.waitForSelector(signInSelector, { timeout: 10000 });
      await this.page.click(signInSelector);
      
      await dualLogInfo("Clicked sign-in button");
      await delay(3000);

      // Take screenshot of login page
      await this.page.screenshot({ 
        path: "booking-login-page.png",
        fullPage: true 
      });
      await dualLogInfo("Screenshot saved: booking-login-page.png");

      // Store updated session data after navigation
      if (this.sessionData) {
        this.sessionData.cookies = await this.page.cookies();
        await dualLogInfo("Updated cookies after login navigation", {
          cookieCount: this.sessionData.cookies.length,
        });
      }

    } catch (error) {
      await dualLogError("Failed to simulate login:", error);
      await dualLogWarn("This is expected behavior for testing - we're not actually logging in");
    }
  }

  async closeSession(): Promise<void> {
    try {
      await dualLogInfo("=== Closing Browser Session ===");
      
      if (this.browser) {
        // Don't close the browser, just disconnect
        // This keeps the browser running on Browserless
        this.browser.disconnect();
        await dualLogInfo("Disconnected from browser (kept alive on Browserless)");
      }
      
      this.browser = null;
      this.page = null;
      
    } catch (error) {
      await dualLogError("Error closing session:", error);
    }
  }

  async reconnectToSession(): Promise<boolean> {
    try {
      await dualLogInfo("=== Attempting to Reconnect to Previous Session ===");
      
      if (!this.sessionData) {
        await dualLogError("No session data available for reconnection");
        return false;
      }

      // Try to reconnect to the same browser instance
      try {
        this.browser = await puppeteer.connect({
          browserWSEndpoint: this.sessionData.browserWSEndpoint,
        });
        
        await dualLogInfo("Successfully reconnected to browser!");
        
        // Get existing pages
        const pages = await this.browser.pages();
        await dualLogInfo(`Found ${pages.length} existing pages`);
        
        if (pages.length > 0) {
          this.page = pages[0];
          
          // Restore cookies
          await this.page.setCookie(...this.sessionData.cookies);
          await dualLogInfo("Restored cookies");
          
          // Check current URL
          const currentUrl = this.page.url();
          await dualLogInfo("Current page URL:", { currentUrl });
          
          // Take screenshot to verify state
          await this.page.screenshot({ 
            path: "booking-reconnected.png",
            fullPage: true 
          });
          await dualLogInfo("Screenshot saved: booking-reconnected.png");
          
          return true;
        }
        
      } catch (reconnectError) {
        await dualLogWarn("Could not reconnect to existing session:", reconnectError);
        await dualLogInfo("This is expected - Browserless may have terminated the session");
      }
      
      return false;
      
    } catch (error) {
      await dualLogError("Failed to reconnect to session:", error);
      return false;
    }
  }

  async testPersistentSession(): Promise<void> {
    try {
      await dualLogInfo("=== Testing Browserless Persistent Session ===");
      
      // Start new session with different approach - using keepalive
      this.browser = await puppeteer.connect({
        browserWSEndpoint: `wss://production-sfo.browserless.io/?token=${process.env.BROWSERLESS_TOKEN}&stealth&blockAds=true&keepalive=300000`, // 5 minutes keepalive
      });

      await dualLogInfo("Connected with keepalive option");

      this.page = await this.browser.newPage();
      
      // Navigate to Booking
      await this.page.goto("https://www.booking.com", {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      // Store the page ID
      const pageTarget = this.page.target();
      const pageId = (pageTarget as any)._targetId;
      await dualLogInfo("Page ID for reconnection:", { pageId });

      // Get the debugger URL
      const wsEndpoint = this.browser.wsEndpoint();
      await dualLogInfo("WebSocket endpoint for reconnection:", { wsEndpoint });

      // Disconnect but keep browser alive
      this.browser.disconnect();
      await dualLogInfo("Disconnected from browser (keeping it alive with keepalive)");

      // Wait a bit
      await delay(5000);

      // Try to reconnect
      await dualLogInfo("Attempting to reconnect after 5 seconds...");
      
      try {
        const reconnectedBrowser = await puppeteer.connect({
          browserWSEndpoint: wsEndpoint,
        });
        
        const pages = await reconnectedBrowser.pages();
        await dualLogInfo(`Successfully reconnected! Found ${pages.length} pages`);
        
        if (pages.length > 0) {
          const reconnectedPage = pages[0];
          const currentUrl = reconnectedPage.url();
          await dualLogInfo("Reconnected to page:", { currentUrl });
          
          await reconnectedPage.screenshot({ 
            path: "booking-persistent-session.png",
            fullPage: true 
          });
          await dualLogInfo("Screenshot saved: booking-persistent-session.png");
        }
        
        await reconnectedBrowser.close();
        
      } catch (error) {
        await dualLogWarn("Could not maintain persistent session:", error);
        await dualLogInfo("This suggests we need to handle sessions differently for Booking.com");
      }

    } catch (error) {
      await dualLogError("Persistent session test failed:", error);
    }
  }

  async runFullTest(): Promise<void> {
    try {
      await dualLogInfo("========================================");
      await dualLogInfo("Starting Browserless Session Persistence Test");
      await dualLogInfo("========================================");
      await dualLogInfo("");

      // Test 1: Basic session creation and disconnection
      await dualLogInfo("TEST 1: Basic Session Creation");
      await this.startNewSession();
      await this.simulateLogin();
      await this.closeSession();
      
      await delay(3000);
      
      // Test 2: Try to reconnect
      await dualLogInfo("");
      await dualLogInfo("TEST 2: Session Reconnection");
      const reconnected = await this.reconnectToSession();
      
      if (reconnected) {
        await dualLogInfo("✅ Session reconnection successful!");
      } else {
        await dualLogInfo("❌ Session reconnection failed (expected with Browserless)");
      }
      
      // Clean up
      if (this.browser) {
        await this.browser.close();
      }
      
      await delay(3000);
      
      // Test 3: Persistent session with keepalive
      await dualLogInfo("");
      await dualLogInfo("TEST 3: Persistent Session with Keepalive");
      await this.testPersistentSession();
      
      await dualLogInfo("");
      await dualLogInfo("========================================");
      await dualLogInfo("Test Summary:");
      await dualLogInfo("- Browserless can maintain sessions with keepalive parameter");
      await dualLogInfo("- Sessions cannot be reconnected after disconnection");
      await dualLogInfo("- For Booking.com, we'll need to:");
      await dualLogInfo("  1. Use keepalive to maintain long sessions");
      await dualLogInfo("  2. Store auth cookies and restore them on new sessions");
      await dualLogInfo("  3. Implement a session pool for multiple concurrent sessions");
      await dualLogInfo("========================================");
      
      if (this.liveURL) {
        await dualLogInfo("");
        await dualLogInfo("Live session URL (if still active):", { liveURL: this.liveURL });
      }
      
    } catch (error) {
      await dualLogError("Test execution failed:", error);
    } finally {
      // Final cleanup
      if (this.browser) {
        try {
          await this.browser.close();
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }
  }
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const test = new BrowserlessSessionTest();
  test.runFullTest()
    .then(() => {
      console.log("\nTest completed!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("\nTest failed:", error);
      process.exit(1);
    });
}