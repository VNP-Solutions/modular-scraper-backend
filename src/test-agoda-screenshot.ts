import dotenv from "dotenv";
import puppeteer from "puppeteer";
import { captureAndUploadAgodaScreenshot } from "./common/agoda-screenshot.js";

dotenv.config();

/**
 * Simple test script to verify Agoda screenshot functionality
 * This script will:
 * 1. Launch a browser
 * 2. Navigate to a test page
 * 3. Take a screenshot and upload to S3
 * 4. Display the S3 URL in console
 */
async function testAgodaScreenshot() {
  let browser = null;

  try {
    console.log("🚀 Starting Agoda screenshot test...");

    // Launch browser
    browser = await puppeteer.launch({
      headless: true,
      defaultViewport: { width: 1920, height: 1080 },
    });

    const page = await browser.newPage();

    // Navigate to a test page (using Agoda's public page)
    console.log("📄 Navigating to test page...");
    await page.goto("https://www.agoda.com", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    // Test the screenshot function
    console.log("📸 Testing screenshot functionality...");
    const testJobId = "test-screenshot-" + Date.now();

    const s3Url = await captureAndUploadAgodaScreenshot(
      page,
      testJobId,
      "test-page",
      "agoda"
    );

    if (s3Url) {
      console.log("\n✅ Screenshot test SUCCESSFUL!");
      console.log(`🔗 S3 URL: ${s3Url}`);
      console.log(
        "\nThe screenshot has been uploaded to S3 and the URL is displayed above."
      );
    } else {
      console.log("\n❌ Screenshot test FAILED!");
      console.log("The screenshot could not be uploaded to S3.");
    }

    // Test with non-agoda platform (should return null)
    console.log("\n🧪 Testing platform filter...");
    const nonAgodaUrl = await captureAndUploadAgodaScreenshot(
      page,
      testJobId,
      "test-non-agoda",
      "expedia"
    );

    if (nonAgodaUrl === null) {
      console.log(
        "✅ Platform filter working correctly - non-Agoda platform ignored"
      );
    } else {
      console.log(
        "❌ Platform filter not working - non-Agoda platform should be ignored"
      );
    }
  } catch (error) {
    console.error("❌ Test failed with error:", error);
  } finally {
    if (browser) {
      await browser.close();
      console.log("🔒 Browser closed");
    }
  }
}

// Run the test
testAgodaScreenshot()
  .then(() => {
    console.log("\n🏁 Test completed");
    process.exit(0);
  })
  .catch((error) => {
    console.error("💥 Test script error:", error);
    process.exit(1);
  });
