import fs from "fs";
import OpenAI from "openai";
import { Page } from "puppeteer";
import { screenshotManager } from "../common/screenshot-manager.js";

export interface CaptchaAnalysis {
  instruction: string;
  positions: number[] | string;
  rawResponse?: string;
  captchaType?: string;
  elements?: any[];
}

export interface CaptchaSolveResult {
  success: boolean;
  method: "openai-vision" | "basic-auto" | "manual";
  analysis?: CaptchaAnalysis;
  clickResult?: {
    totalElements: number;
    successfulClicks: number;
  };
  error?: string;
  analysisError?: string;
  clickError?: string;
}

export interface CaptchaServiceConfig {
  openaiApiKey?: string;
  maxRetries?: number;
  timeout?: number;
  enableOpenAIVision?: boolean;
  enableBasicAuto?: boolean;
  jobId?: string;
}

export class CaptchaService {
  private openai?: OpenAI;
  private config: Required<CaptchaServiceConfig>;

  constructor(config: CaptchaServiceConfig = {}) {
    this.config = {
      openaiApiKey: config.openaiApiKey || process.env.OPENAI_API_KEY || "",
      maxRetries: config.maxRetries || 3,
      timeout: config.timeout || 120000,
      enableOpenAIVision: config.enableOpenAIVision !== false,
      enableBasicAuto: config.enableBasicAuto !== false,
      jobId: config.jobId || "",
    };

    // Set job ID in screenshot manager if provided
    if (this.config.jobId) {
      screenshotManager.setJobId(this.config.jobId);
    }

    // Initialize OpenAI if API key is provided
    if (this.config.openaiApiKey && this.config.enableOpenAIVision) {
      this.openai = new OpenAI({ apiKey: this.config.openaiApiKey });
      console.log("✅ OpenAI Vision initialized for captcha solving");
    }
  }

  /**
   * Set the job ID for screenshot organization
   */
  setJobId(jobId: string): void {
    this.config.jobId = jobId;
    screenshotManager.setJobId(jobId);
  }

  /**
   * Clean up screenshots for a specific job
   */
  async cleanupJobScreenshots(jobId?: string, reason?: string): Promise<void> {
    await screenshotManager.cleanupJobScreenshots(
      jobId || this.config.jobId,
      reason
    );
  }

  /**
   * Main method to solve captcha with multiple fallback methods
   */
  async solveCaptcha(
    page: Page,
    logInfo: (message: string, data?: any) => Promise<void>
  ): Promise<CaptchaSolveResult> {
    await logInfo("🤖 Starting advanced captcha solving with multiple methods");

    // Method 1: OpenAI Vision (if enabled and configured)
    if (this.openai && this.config.enableOpenAIVision) {
      await logInfo("🔍 Attempting OpenAI Vision captcha solving");
      const openaiResult = await this.solveWithOpenAIVision(page, logInfo);
      if (openaiResult.success) {
        await logInfo("✅ Captcha solved successfully with OpenAI Vision");
        return openaiResult;
      }

      // If OpenAI detected no captcha, don't try other methods
      if (openaiResult.analysis?.captchaType === "no_captcha") {
        await logInfo(
          "🚫 No captcha detected by OpenAI Vision, skipping other methods"
        );
        return openaiResult;
      }

      await logInfo("❌ OpenAI Vision method failed, trying next method");
    }

    // Method 2: Basic automatic solving (if enabled)
    if (this.config.enableBasicAuto) {
      await logInfo("🔧 Attempting basic automatic captcha solving");
      const basicResult = await this.solveWithBasicMethod(page, logInfo);
      if (basicResult.success) {
        await logInfo("✅ Captcha solved successfully with basic method");
        return basicResult;
      }
      await logInfo("❌ Basic automatic method failed");
    }

    // All automatic methods failed
    await logInfo("❌ All automatic captcha solving methods failed");
    return {
      success: false,
      method: "manual",
      error: "All automatic captcha solving methods failed",
    };
  }

  /**
   * Solve captcha using OpenAI Vision
   */
  private async solveWithOpenAIVision(
    page: Page,
    logInfo: (message: string, data?: any) => Promise<void>
  ): Promise<CaptchaSolveResult> {
    try {
      if (!this.openai) {
        return {
          success: false,
          method: "openai-vision",
          error: "OpenAI not initialized",
        };
      }

      // Set FIXED viewport for consistent positioning - EXACT from openai-booking
      await page.setViewport({
        width: 1905,
        height: 945,
      });

      // Take screenshot for analysis using screenshot manager
      await logInfo("📸 Taking screenshot for OpenAI Vision analysis");
      const screenshotFilename =
        screenshotManager.generateCaptchaScreenshotName(
          "openai_vision",
          "analysis"
        );
      const screenshotPath = await screenshotManager.saveScreenshot(
        page,
        screenshotFilename,
        this.config.jobId,
        {
          fullPage: false,
          type: "png",
        }
      );

      // Read screenshot as base64
      const screenshotBuffer = fs.readFileSync(screenshotPath);
      const base64Screenshot = screenshotBuffer.toString("base64");

      // Analyze with OpenAI Vision
      await logInfo("🧠 Analyzing captcha with OpenAI Vision");
      const analysis = await this.analyzeWithOpenAI(base64Screenshot);

      if (!analysis) {
        return {
          success: false,
          method: "openai-vision",
          analysisError: "Failed to analyze captcha with OpenAI Vision",
        };
      }

      // Check if this is actually a captcha page
      const isCaptchaPage = this.detectCaptchaFromAnalysis(analysis);
      if (!isCaptchaPage) {
        await logInfo(
          "🚫 No captcha detected on this page, skipping captcha solving"
        );
        return {
          success: true, // Return success since no captcha solving is needed
          method: "openai-vision",
          analysis: {
            instruction: analysis.instruction || "No captcha detected",
            positions: analysis.positions || [],
            rawResponse: analysis.rawResponse,
            captchaType: "no_captcha",
          },
          error: "No captcha present on page",
        };
      }

      await logInfo("✅ Captcha detected, proceeding with solving");

      let positionsCount = 0;
      try {
        if (Array.isArray(analysis.positions)) {
          positionsCount = analysis.positions.length;
        } else if (typeof analysis.positions === "string") {
          const parsed = JSON.parse(analysis.positions || "[]");
          positionsCount = Array.isArray(parsed) ? parsed.length : 0;
        }
      } catch (e) {
        positionsCount = 0;
      }

      await logInfo("🎯 OpenAI Vision analysis completed", {
        captchaType: analysis.captchaType,
        positionsFound: positionsCount,
      });

      // Execute clicks based on analysis
      const clickResult = await this.executeClicksFromAnalysis(
        page,
        analysis,
        logInfo
      );

      // Wait briefly for any animations/processing
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Try to submit the captcha
      await this.submitCaptcha(page, logInfo);

      // Quick wait for submission processing
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Check if captcha was solved by looking for navigation or absence of captcha elements
      const solved = await this.checkIfCaptchaSolved(page, logInfo);

      return {
        success: solved,
        method: "openai-vision",
        analysis: {
          instruction: analysis.instruction || "No instruction provided",
          positions: analysis.positions || [],
          rawResponse: analysis.rawResponse,
          captchaType: analysis.captchaType || "grid_selection",
        },
        clickResult,
        error: solved
          ? undefined
          : "Captcha elements still present after solving attempt",
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await logInfo("❌ OpenAI Vision captcha solving failed", {
        error: errorMessage,
      });
      return {
        success: false,
        method: "openai-vision",
        error: errorMessage,
      };
    }
  }

  /**
   * Detect if the page actually contains a captcha based on OpenAI analysis
   */
  private detectCaptchaFromAnalysis(analysis: any): boolean {
    if (!analysis || !analysis.instruction) {
      return false;
    }

    const instruction = analysis.instruction.toLowerCase();
    const positions = analysis.positions;

    // Check if instruction contains captcha-like patterns
    const captchaPatterns = [
      /choose all the/i,
      /choose all/i,
      /select all the/i,
      /click on all/i,
      /identify all/i,
      /find all/i,
    ];

    const hasCaptchaInstruction = captchaPatterns.some((pattern) =>
      pattern.test(instruction)
    );

    // Check if positions array has valid values
    let hasValidPositions = false;
    try {
      let positionsArray = positions;
      if (typeof positions === "string") {
        positionsArray = JSON.parse(positions);
      }

      if (Array.isArray(positionsArray) && positionsArray.length > 0) {
        // Check if positions contain valid numbers (1-9 for grid captcha)
        hasValidPositions = positionsArray.every(
          (pos) => typeof pos === "number" && pos >= 1 && pos <= 9
        );
      }
    } catch (e) {
      hasValidPositions = false;
    }

    // It's a captcha if both conditions are met
    const isCaptcha = hasCaptchaInstruction && hasValidPositions;

    console.log("🔍 Captcha Detection Analysis:", {
      instruction: instruction,
      hasCaptchaInstruction,
      positions: positions,
      hasValidPositions,
      isCaptcha,
    });

    return isCaptcha;
  }

  /**
   * Analyze captcha using OpenAI Vision API - Exact implementation from openai-booking
   */
  private async analyzeWithOpenAI(base64Screenshot: string): Promise<any> {
    try {
      console.log("🤖 Starting captcha analysis with OpenAI Vision...");
      console.log("🔄 Sending screenshot to OpenAI Vision API...");

      // Analyze the screenshot with OpenAI Vision with timeout
      const response = (await Promise.race([
        this.openai!.chat.completions.create({
          model: "gpt-4.1", // Use GPT-4o (latest available model with vision capabilities)
          messages: [
            {
              role: "system",
              content:
                "You are an expert at analyzing CAPTCHA images. You must provide accurate, precise responses in the exact JSON format requested, or 50 kitten will be in danger.",
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `From this image, there are 9 different picture in three rows. Top left corner is 1 and right of that is 2, then 3, like this the last one from bottom right corner is 9. You will analyze which picture is what, then make a list of all the pictures. Then, after analyzing every picture, you will match with the instruction, and generate result. You will give me a json like this: { "instruction": "Instruction from Image", "positions": "[1, 3, 4, 5, 6]", list: { "1": "Hat", "2": "Bucket", "3": "Bag", "4": "Bag", "5": "Hat", "6": "Bed", "7": "Hat", "8": "Curtain", "9": "Clock" } }`,
                },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:image/png;base64,${base64Screenshot}`,
                    detail: "high",
                  },
                },
              ],
            },
          ],
        }),
        // Add timeout to prevent hanging
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("OpenAI API timeout after 20 seconds")),
            20000
          )
        ),
      ])) as any;

      const analysisResult = response.choices[0]?.message?.content;
      if (!analysisResult) {
        throw new Error("No content received from OpenAI Vision API");
      }

      console.log("📋 OpenAI Vision Analysis Result:");
      console.log(analysisResult);

      // Try to parse the JSON response - EXACT implementation from openai-booking
      let parsedResult;
      try {
        // First try to parse the entire response as JSON
        parsedResult = JSON.parse(analysisResult);
      } catch (parseError1) {
        try {
          // Extract JSON from markdown code blocks
          const codeBlockMatch = analysisResult.match(
            /```(?:json)?\s*(\{[\s\S]*?\})\s*```/
          );
          if (codeBlockMatch) {
            parsedResult = JSON.parse(codeBlockMatch[1]);
          } else {
            // Extract JSON from the response (in case there's additional text)
            const jsonMatch = analysisResult.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              parsedResult = JSON.parse(jsonMatch[0]);
            } else {
              throw new Error("No JSON found in response");
            }
          }
        } catch (parseError2) {
          const errorMessage =
            parseError2 instanceof Error
              ? parseError2.message
              : String(parseError2);
          console.log("⚠️ Could not parse JSON response, using raw text");
          console.log("Parse error:", errorMessage);
          parsedResult = {
            elements: [],
            captchaType: "unknown",
            instructions: analysisResult,
            rawResponse: analysisResult,
          };
        }
      }

      console.log("✅ Captcha analysis completed!");
      console.log("🎯 Found elements:", parsedResult.elements?.length || 0);
      console.log("🔍 Captcha type:", parsedResult.captchaType || "unknown");

      return parsedResult;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.log(
        "❌ Error analyzing captcha with OpenAI Vision:",
        errorMessage
      );
      return null;
    }
  }

  /**
   * Execute clicks based on OpenAI analysis - Exact implementation from openai-booking
   */
  private async executeClicksFromAnalysis(
    page: Page,
    analysis: any,
    logInfo: (message: string, data?: any) => Promise<void>
  ): Promise<{ totalElements: number; successfulClicks: number }> {
    if (!analysis || !analysis.positions) {
      await logInfo("❌ No positions found in analysis");
      return { totalElements: 0, successfulClicks: 0 };
    }

    // Parse positions from the analysis - EXACT implementation from openai-booking
    let positionsArray = analysis.positions;
    if (typeof positionsArray === "string") {
      try {
        positionsArray = JSON.parse(positionsArray);
      } catch (e) {
        await logInfo(
          "⚠️ Could not parse positions, trying as comma-separated values"
        );
        positionsArray = positionsArray
          .replace(/[\[\]]/g, "")
          .split(",")
          .map((p: string) => parseInt(p.trim()))
          .filter((p: number) => !isNaN(p));
      }
    }

    await logInfo("📍 Positions to click:", positionsArray);
    await logInfo(
      "📋 Instruction:",
      analysis.instruction || "No instruction provided"
    );

    // Define the fixed coordinates for positions 1-9 - EXACT coordinates from openai-booking
    const coordinateMap: { [key: number]: { x: number; y: number } } = {
      1: { x: 819, y: 275 },
      2: { x: 954, y: 275 },
      3: { x: 1089, y: 275 },
      4: { x: 822, y: 416 },
      5: { x: 952, y: 416 },
      6: { x: 1087, y: 416 },
      7: { x: 822, y: 550 },
      8: { x: 955, y: 550 },
      9: { x: 1089, y: 550 },
    };

    const clickResults = [];
    let successfulClicks = 0;

    // Click grid positions - EXACT implementation from openai-booking
    for (let i = 0; i < positionsArray.length; i++) {
      const position = positionsArray[i];
      const coords = coordinateMap[position];

      if (!coords) {
        await logInfo(`❌ Invalid position: ${position} (must be 1-9)`);
        clickResults.push({
          position: position,
          success: false,
          error: `Invalid position: ${position}`,
        });
        continue;
      }

      // await logInfo(
      //   `🎯 Clicking position ${position} at coordinates (${coords.x}, ${coords.y})`
      // );

      try {
        // Add visual indicator - EXACT implementation from openai-booking
        await page.evaluate(
          (x, y, pos) => {
            const indicator = document.createElement("div");
            indicator.style.position = "absolute";
            indicator.style.left = x - 15 + "px";
            indicator.style.top = y - 15 + "px";
            indicator.style.width = "30px";
            indicator.style.height = "30px";
            indicator.style.backgroundColor = "rgba(255, 0, 0, 0.5)";
            indicator.style.border = "3px solid yellow";
            indicator.style.borderRadius = "50%";
            indicator.style.zIndex = "9999";
            indicator.style.pointerEvents = "none";
            indicator.style.fontSize = "14px";
            indicator.style.color = "white";
            indicator.style.textAlign = "center";
            indicator.style.lineHeight = "24px";
            indicator.style.fontWeight = "bold";
            indicator.textContent = pos;
            indicator.className = "click-indicator";
            document.body.appendChild(indicator);
          },
          coords.x,
          coords.y,
          position
        );

        // Wait a moment so you can see the indicator
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Click on the coordinates
        await page.mouse.click(coords.x, coords.y, { delay: 50 });

        await logInfo(
          `   ✅ Successfully clicked position ${position} at (${coords.x}, ${coords.y})`
        );

        clickResults.push({
          position: position,
          success: true,
          coordinates: coords,
        });

        successfulClicks++;

        // Quick delay between clicks
        const delay = Math.floor(Math.random() * 200) + 100; // 100-300ms
        await logInfo(`   ⏱️ Waiting ${Math.round(delay)}ms before next click`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } catch (clickError) {
        const errorMessage =
          clickError instanceof Error ? clickError.message : String(clickError);
        await logInfo(
          `   ❌ Failed to click position ${position}: ${errorMessage}`
        );
        clickResults.push({
          position: position,
          success: false,
          error: errorMessage,
          coordinates: coords,
        });
      }
    }

    // Clean up indicators
    await page.evaluate(() => {
      const indicators = document.querySelectorAll(".click-indicator");
      indicators.forEach((indicator) => indicator.remove());
    });

    await logInfo(
      `📊 Grid clicks: ${successfulClicks}/${clickResults.length} successful`
    );

    // Now click the OK/Confirm button at fixed coordinates - EXACT implementation from openai-booking
    await logInfo("🔘 Clicking OK/Confirm button...");
    const okButtonCoords = { x: 1100, y: 657 };

    try {
      // Add visual indicator for OK button
      await page.evaluate(
        (x, y) => {
          const indicator = document.createElement("div");
          indicator.style.position = "absolute";
          indicator.style.left = x - 20 + "px";
          indicator.style.top = y - 20 + "px";
          indicator.style.width = "40px";
          indicator.style.height = "40px";
          indicator.style.backgroundColor = "rgba(0, 255, 0, 0.5)";
          indicator.style.border = "3px solid blue";
          indicator.style.borderRadius = "50%";
          indicator.style.zIndex = "9999";
          indicator.style.pointerEvents = "none";
          indicator.style.fontSize = "16px";
          indicator.style.color = "white";
          indicator.style.textAlign = "center";
          indicator.style.lineHeight = "34px";
          indicator.style.fontWeight = "bold";
          indicator.textContent = "OK";
          indicator.className = "ok-button-indicator";
          document.body.appendChild(indicator);
        },
        okButtonCoords.x,
        okButtonCoords.y
      );

      // Wait a moment to show the indicator
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Click the OK button
      await page.mouse.click(okButtonCoords.x, okButtonCoords.y, { delay: 50 });

      await logInfo(
        `   ✅ Successfully clicked OK button at (${okButtonCoords.x}, ${okButtonCoords.y})`
      );

      // Clean up OK button indicator
      await page.evaluate(() => {
        const indicator = document.querySelector(".ok-button-indicator");
        if (indicator) indicator.remove();
      });

      successfulClicks++; // Count OK button as successful click

      // Wait for page response after OK button
      await logInfo("   ⏱️ Waiting 1500ms for page response after OK button");
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch (okButtonError) {
      const errorMessage =
        okButtonError instanceof Error
          ? okButtonError.message
          : String(okButtonError);
      await logInfo(`   ❌ Failed to click OK button: ${errorMessage}`);
    }

    return { totalElements: positionsArray.length + 1, successfulClicks }; // +1 for OK button
  }

  /**
   * Basic automatic captcha solving (existing logic)
   */
  private async solveWithBasicMethod(
    page: Page,
    logInfo: (message: string, data?: any) => Promise<void>
  ): Promise<CaptchaSolveResult> {
    try {
      await logInfo("🔧 Attempting basic automatic captcha solution");

      // Wait for captcha images to load
      await page.waitForSelector("img", { timeout: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Get all images and click on potential clock images
      const images = await page.$$("img");
      await logInfo(`Found ${images.length} images to analyze`);

      let clocksFound = 0;
      for (let i = 0; i < images.length; i++) {
        try {
          const imgElement = images[i];
          const box = await imgElement.boundingBox();
          if (box && box.width > 50 && box.height > 50) {
            await logInfo(`Clicking image ${i + 1}`);
            await imgElement.click();
            clocksFound++;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        } catch (e) {
          // Skip images that can't be clicked
        }
      }

      await logInfo(`Clicked ${clocksFound} potential clock images`);

      // Submit the captcha
      await this.submitCaptcha(page, logInfo);

      // Check if captcha is solved
      const solved = await this.checkIfCaptchaSolved(page, logInfo);

      return {
        success: solved,
        method: "basic-auto",
        clickResult: {
          totalElements: images.length,
          successfulClicks: clocksFound,
        },
        error: solved
          ? undefined
          : "Captcha elements still present after basic solving attempt",
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await logInfo("❌ Basic automatic captcha solution failed", {
        error: errorMessage,
      });
      return {
        success: false,
        method: "basic-auto",
        error: errorMessage,
      };
    }
  }

  /**
   * Submit captcha form after clicking elements
   */
  private async submitCaptcha(
    page: Page,
    logInfo: (message: string, data?: any) => Promise<void>
  ): Promise<void> {
    const confirmSelectors = [
      'button:has-text("Confirm")',
      'button:has-text("Submit")',
      'button:has-text("Verify")',
      'input[value="Confirm"]',
      'input[value="Submit"]',
      'button[type="submit"]',
      ".captcha-submit",
      "#captcha-submit",
    ];

    for (const selector of confirmSelectors) {
      try {
        // Handle text-based selectors differently
        if (selector.includes("has-text")) {
          const textToFind = selector.match(/has-text\("([^"]+)"\)/)?.[1];
          if (textToFind) {
            const element = await page.evaluateHandle((text) => {
              const buttons = Array.from(document.querySelectorAll("button"));
              return buttons.find((btn) =>
                btn.textContent?.toLowerCase().includes(text.toLowerCase())
              );
            }, textToFind);

            const elementHandle = element.asElement() as any;
            if (elementHandle) {
              await elementHandle.click();
              await logInfo(
                `✅ Clicked submit button with text: ${textToFind}`
              );
              return;
            }
          }
        } else {
          const element = await page.$(selector);
          if (element) {
            await element.click();
            await logInfo(
              `✅ Clicked submit button with selector: ${selector}`
            );
            return;
          }
        }
      } catch (error) {
        // Continue to next selector
      }
    }

    await logInfo("⚠️ No submit button found for captcha");
  }

  /**
   * Check if captcha has been solved
   */
  private async checkIfCaptchaSolved(
    page: Page,
    logInfo?: (message: string, data?: any) => Promise<void>
  ): Promise<boolean> {
    try {
      // Wait a moment for any page changes
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Check if we're still on the same page or if captcha elements are gone
      const pageContent = await page.content();
      const currentUrl = page.url();

      // Common captcha patterns to check for absence
      const captchaPatterns = [/let'?s (make sure|confirm) you'?re? human/i];

      const hasCaptchaContent = captchaPatterns.some((pattern) =>
        pattern.test(pageContent)
      );

      // Check for URL changes that indicate captcha was solved
      const urlChanged =
        !currentUrl.includes("captcha") && !currentUrl.includes("challenge");

      // Check for specific success indicators only if captcha content is gone
      const successIndicators = [
        "dashboard",
        "welcome",
        "login-success",
        "admin.booking.com",
      ];

      const hasSuccessIndicators = successIndicators.some(
        (indicator) =>
          pageContent.toLowerCase().includes(indicator) ||
          currentUrl.toLowerCase().includes(indicator)
      );

      // Captcha is considered solved ONLY if:
      // 1. No captcha content is found AND (URL changed OR has success indicators)
      const solved = !hasCaptchaContent && (urlChanged || hasSuccessIndicators);

      if (logInfo) {
        await logInfo(
          `🔍 Captcha status check: hasCaptcha=${hasCaptchaContent}, urlChanged=${urlChanged}, hasSuccess=${hasSuccessIndicators}, solved=${solved}`
        );
      }

      return solved;
    } catch (error) {
      console.error("Error checking captcha status:", error);
      return false;
    }
  }
}
