import dotenv from "dotenv";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";

dotenv.config();

export interface CaptchaConfig {
  enabled: boolean;
  apiKey?: string;
  timeout: number;
  pollingInterval: number;
  softId?: number;
}

export function getCaptchaConfig(): CaptchaConfig {
  const enabled = process.env.ENABLE_2CAPTCHA === "true";
  const apiKey = process.env.TWOCAPTCHA_API_KEY;

  if (enabled && !apiKey) {
    dualLogError("2captcha is enabled but TWOCAPTCHA_API_KEY is not set");
  }

  const config: CaptchaConfig = {
    enabled,
    apiKey,
    timeout: parseInt(process.env.TWOCAPTCHA_TIMEOUT || "300000"),
    pollingInterval: parseInt(
      process.env.TWOCAPTCHA_POLLING_INTERVAL || "5000"
    ),
    softId: process.env.TWOCAPTCHA_SOFT_ID
      ? parseInt(process.env.TWOCAPTCHA_SOFT_ID)
      : undefined,
  };

  if (enabled) {
    dualLogInfo("2captcha configuration loaded", {
      timeout: config.timeout,
      pollingInterval: config.pollingInterval,
      hasApiKey: !!config.apiKey,
    });
  }

  return config;
}
