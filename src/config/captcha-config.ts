/**
 * Configuration for advanced captcha solving capabilities
 *
 * This module integrates multiple captcha solving methods:
 * 1. OpenAI Vision API - Advanced AI-powered captcha analysis and solving
 * 2. Basic Automatic - Simple image clicking algorithm (fallback)
 * 3. Manual Email - Email notification for manual intervention (final fallback)
 */

export interface CaptchaConfig {
  // OpenAI Vision API configuration
  openaiApiKey?: string;
  enableOpenAIVision: boolean;

  // Basic automatic solving
  enableBasicAuto: boolean;

  // Retry and timeout settings
  maxRetries: number;
  timeout: number;
  retryDelay: number;

  // Email notification settings
  captchaRecipients: string[];
}

/**
 * Load captcha configuration from environment variables
 */
export function loadCaptchaConfig(): CaptchaConfig {
  return {
    // OpenAI Vision API
    openaiApiKey: process.env.OPENAI_API_KEY,
    enableOpenAIVision: process.env.ENABLE_OPENAI_VISION !== "false",

    // Basic automatic solving
    enableBasicAuto: process.env.ENABLE_BASIC_AUTO !== "false",

    // Retry and timeout settings
    maxRetries: parseInt(process.env.CAPTCHA_MAX_RETRIES || "3"),
    timeout: parseInt(process.env.CAPTCHA_TIMEOUT || "120000"), // 2 minutes
    retryDelay: parseInt(process.env.CAPTCHA_RETRY_DELAY || "5000"), // 5 seconds

    // Email notification
    captchaRecipients: process.env.CAPTCHA_RECIPIENTS
      ? process.env.CAPTCHA_RECIPIENTS.split(",").map((email) => email.trim())
      : [],
  };
}

/**
 * Environment variables documentation:
 *
 * Required for OpenAI Vision:
 * - OPENAI_API_KEY: Your OpenAI API key from https://platform.openai.com/api-keys
 *
 * Optional configurations:
 * - ENABLE_OPENAI_VISION: Enable/disable OpenAI Vision (default: true)
 * - ENABLE_BASIC_AUTO: Enable basic automatic solving (default: true)
 * - CAPTCHA_MAX_RETRIES: Maximum retry attempts (default: 3)
 * - CAPTCHA_TIMEOUT: Timeout in milliseconds (default: 120000)
 * - CAPTCHA_RETRY_DELAY: Delay between retries in milliseconds (default: 5000)
 * - CAPTCHA_RECIPIENTS: Comma-separated email addresses for manual captcha notifications
 *
 * Example .env configuration:
 * OPENAI_API_KEY=sk-proj-your-openai-api-key-here
 * ENABLE_OPENAI_VISION=true
 * ENABLE_BASIC_AUTO=true
 * CAPTCHA_MAX_RETRIES=3
 * CAPTCHA_TIMEOUT=120000
 * CAPTCHA_RECIPIENTS=admin@example.com,support@example.com
 */
