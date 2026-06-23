import puppeteer, { Browser } from "puppeteer";
import fetch from "node-fetch";
import { PlatformsType } from "../common/booking-error-types.js";
import { encrypt, decrypt } from "../common/encription.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import {
  BrowserlessSession,
  IBrowserlessSession,
} from "../models/browserless-session.model.js";
import { CookieData } from "./cookie-storage.service.js";

export interface BrowserlessSessionResponse {
  id: string;
  connect: string;
  stop: string;
  browserQL?: string;
  ttl: number;
  cloudEndpointId?: string | null;
}

export interface BrowserlessSessionCreateConfig {
  ttl?: number;
  processKeepAlive?: number;
  stealth?: boolean;
  headless?: boolean;
  args?: string[];
}

export interface BrowserlessProxySettings {
  type: "residential" | "datacenter";
  country: string;
  sticky: boolean;
}

export interface UnblockResult {
  cookies?: CookieData[];
  browserWSEndpoint?: string;
  content?: string;
}

export interface GetOrCreateSessionResult {
  session: BrowserlessSessionResponse;
  isNew: boolean;
  reused: boolean;
}

/** Default session lifetime: 90 days (Browserless Scale plan maximum). */
const DEFAULT_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export class BrowserlessSessionService {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor() {
    this.token = process.env.BROWSERLESS_TOKEN || "";
    this.baseUrl =
      process.env.BROWSERLESS_BASE_URL ||
      "https://production-sfo.browserless.io";
  }

  normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private encryptUrl(url: string): string {
    return JSON.stringify(encrypt(url));
  }

  private decryptUrl(encryptedString: string): string {
    const encryptedData = JSON.parse(encryptedString);
    return decrypt(encryptedData);
  }

  getSessionTtlMs(): number {
    const ttl = parseInt(process.env.BROWSERLESS_SESSION_TTL || "", 10);
    return Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_SESSION_TTL_MS;
  }

  /**
   * Keep the browser process alive after disconnect for the same duration as session TTL
   * (Browserless requires processKeepAlive ≤ ttl).
   */
  getProcessKeepAliveMs(): number {
    const ttl = this.getSessionTtlMs();
    const processKeepAlive = parseInt(
      process.env.BROWSERLESS_PROCESS_KEEP_ALIVE || "",
      10
    );
    if (Number.isFinite(processKeepAlive) && processKeepAlive >= 0) {
      return Math.min(processKeepAlive, ttl);
    }
    return ttl;
  }

  private getDefaultSessionConfig(): Required<
    Pick<
      BrowserlessSessionCreateConfig,
      "ttl" | "processKeepAlive" | "stealth" | "headless" | "args"
    >
  > {
    const ttl = this.getSessionTtlMs();
    const processKeepAlive = this.getProcessKeepAliveMs();

    return {
      ttl,
      processKeepAlive,
      stealth: process.env.BROWSERLESS_STEALTH !== "false",
      headless: process.env.BROWSERLESS_HEADLESS === "true",
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--enable-javascript",
        "--disable-web-security",
        "--window-size=2560,1440",
      ],
    };
  }

  /**
   * Built-in Browserless proxy defaults: residential, US, sticky IP per session.
   * Set BROWSERLESS_PROXY=false to disable.
   */
  getProxySettings(): BrowserlessProxySettings | null {
    const disabled =
      process.env.BROWSERLESS_PROXY === "false" ||
      process.env.BROWSERLESS_PROXY === "none";
    if (disabled) {
      return null;
    }

    const rawType = process.env.BROWSERLESS_PROXY || "residential";
    const type: BrowserlessProxySettings["type"] =
      rawType === "datacenter" ? "datacenter" : "residential";

    const country = (
      process.env.BROWSERLESS_PROXY_COUNTRY ||
      process.env.LOCATION_COUNTRY_CODE ||
      "us"
    )
      .trim()
      .toLowerCase();

    const sticky = process.env.BROWSERLESS_PROXY_STICKY !== "false";

    return { type, country, sticky };
  }

  private applyProxyQueryParams(params: URLSearchParams): void {
    const proxy = this.getProxySettings();
    if (!proxy) {
      return;
    }

    params.set("proxy", proxy.type);
    params.set("proxyCountry", proxy.country);
    if (proxy.sticky) {
      params.set("proxySticky", "true");
    }
  }

  private buildSessionProxyBody():
    | {
        type: BrowserlessProxySettings["type"];
        sticky: boolean;
        country: string;
      }
    | undefined {
    const proxy = this.getProxySettings();
    if (!proxy) {
      return undefined;
    }

    return {
      type: proxy.type,
      sticky: proxy.sticky,
      country: proxy.country.toUpperCase(),
    };
  }

  private buildUnblockQueryParams(timeout: number): URLSearchParams {
    const params = new URLSearchParams({
      timeout: String(timeout),
      token: this.token,
    });

    this.applyProxyQueryParams(params);

    return params;
  }

  async findActiveSession(
    email: string,
    platform: PlatformsType = PlatformsType.BOOKING
  ): Promise<IBrowserlessSession | null> {
    const normalizedEmail = this.normalizeEmail(email);

    return BrowserlessSession.findOne({
      email: normalizedEmail,
      platform,
      is_active: true,
      expires_at: { $gt: new Date() },
    });
  }

  async saveSession(
    email: string,
    session: BrowserlessSessionResponse,
    platform: PlatformsType = PlatformsType.BOOKING
  ): Promise<IBrowserlessSession | null> {
    try {
      const normalizedEmail = this.normalizeEmail(email);
      const expiresAt = new Date(Date.now() + session.ttl);

      const saved = await BrowserlessSession.findOneAndUpdate(
        { email: normalizedEmail, platform },
        {
          $set: {
            session_id: session.id,
            connect_url: this.encryptUrl(session.connect),
            stop_url: this.encryptUrl(session.stop),
            browserql_url: session.browserQL
              ? this.encryptUrl(session.browserQL)
              : undefined,
            ttl: session.ttl,
            expires_at: expiresAt,
            last_used: new Date(),
            is_active: true,
            cloud_endpoint_id: session.cloudEndpointId ?? null,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      await dualLogInfo(
        `Saved Browserless session ${session.id} for ${normalizedEmail}`
      );
      return saved;
    } catch (error) {
      await dualLogError("Failed to save Browserless session:", error);
      return null;
    }
  }

  async deactivateSession(
    email: string,
    platform: PlatformsType = PlatformsType.BOOKING
  ): Promise<void> {
    const normalizedEmail = this.normalizeEmail(email);
    await BrowserlessSession.updateOne(
      { email: normalizedEmail, platform },
      { $set: { is_active: false } }
    );
  }

  async touchSession(sessionId: string): Promise<void> {
    await BrowserlessSession.updateOne(
      { session_id: sessionId, is_active: true },
      { $set: { last_used: new Date() } }
    );
  }

  toSessionResponse(record: IBrowserlessSession): BrowserlessSessionResponse {
    return {
      id: record.session_id,
      connect: this.decryptUrl(record.connect_url),
      stop: this.decryptUrl(record.stop_url),
      browserQL: record.browserql_url
        ? this.decryptUrl(record.browserql_url)
        : undefined,
      ttl: record.ttl,
      cloudEndpointId: record.cloud_endpoint_id,
    };
  }

  async createPersistentSession(
    config?: BrowserlessSessionCreateConfig
  ): Promise<BrowserlessSessionResponse> {
    if (!this.token) {
      throw new Error("BROWSERLESS_TOKEN is not configured");
    }

    const defaults = this.getDefaultSessionConfig();
    const proxyBody = this.buildSessionProxyBody();
    const sessionConfig = {
      ttl: config?.ttl ?? defaults.ttl,
      processKeepAlive: config?.processKeepAlive ?? defaults.processKeepAlive,
      stealth: config?.stealth ?? defaults.stealth,
      headless: config?.headless ?? defaults.headless,
      args: config?.args ?? defaults.args,
      ...(proxyBody ? { proxy: proxyBody } : {}),
    };

    const queryParams = new URLSearchParams({ token: this.token });
    this.applyProxyQueryParams(queryParams);

    if (proxyBody) {
      await dualLogInfo("Creating Browserless session with proxy", {
        type: proxyBody.type,
        country: proxyBody.country,
        sticky: proxyBody.sticky,
      });
    }

    await dualLogInfo("Creating Browserless session", {
      ttlMs: sessionConfig.ttl,
      processKeepAliveMs: sessionConfig.processKeepAlive,
    });

    const response = await fetch(
      `${this.baseUrl}/session?${queryParams.toString()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sessionConfig),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to create Browserless session: ${response.status} ${errorText}`
      );
    }

    return (await response.json()) as BrowserlessSessionResponse;
  }

  buildConnectUrl(connectUrl: string): string {
    const rawTimeout = parseInt(
      process.env.BROWSERLESS_CONNECT_TIMEOUT || "",
      10
    );
    const connectionTimeout =
      Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 300_000;

    const [base, query = ""] = connectUrl.split("?");
    const params = new URLSearchParams(query);

    if (!params.has("timeout")) {
      params.set("timeout", String(connectionTimeout));
    }

    const proxy = this.getProxySettings();
    if (proxy) {
      if (!params.has("proxy")) {
        params.set("proxy", proxy.type);
      }
      if (!params.has("proxyCountry")) {
        params.set("proxyCountry", proxy.country);
      }
      if (proxy.sticky && !params.has("proxySticky")) {
        params.set("proxySticky", "true");
      }
    }

    const serialized = params.toString();
    return serialized ? `${base}?${serialized}` : base;
  }

  private isSessionBusyError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("429");
  }

  /**
   * Connect once to a persisted session. Retries on 429 (session locked by another client).
   * Do not probe-connect elsewhere — Browserless allows only one client at a time.
   */
  async connectToSession(connectUrl: string): Promise<Browser> {
    const wsUrl = this.buildConnectUrl(connectUrl);
    const maxAttempts = parseInt(
      process.env.BROWSERLESS_CONNECT_RETRIES || "",
      10
    );
    const attempts =
      Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : 5;
    const baseDelayMs = parseInt(
      process.env.BROWSERLESS_CONNECT_RETRY_DELAY_MS || "",
      10
    );
    const retryDelay =
      Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 2000;

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await puppeteer.connect({
          browserWSEndpoint: wsUrl,
          protocolTimeout: 300_000,
          defaultViewport: null,
        });
      } catch (error) {
        lastError = error;
        if (this.isSessionBusyError(error) && attempt < attempts) {
          const delayMs = retryDelay * attempt;
          await dualLogInfo(
            `Browserless session busy (429), retrying connect in ${delayMs}ms`,
            { attempt, attempts }
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  async invalidateSessionForEmail(
    email: string,
    session: BrowserlessSessionResponse,
    platform: PlatformsType = PlatformsType.BOOKING
  ): Promise<void> {
    await this.stopRemoteSession(session.stop);
    await this.deactivateSession(email, platform);
  }

  async stopRemoteSession(stopUrl: string): Promise<boolean> {
    try {
      const separator = stopUrl.includes("?") ? "&" : "?";
      const response = await fetch(`${stopUrl}${separator}force=true`, {
        method: "DELETE",
      });

      if (response.ok) {
        await dualLogInfo("Browserless remote session stopped");
        return true;
      }

      const errorText = await response.text();
      await dualLogError(
        `Failed to stop Browserless session (${response.status}): ${errorText}`
      );
      return false;
    } catch (error) {
      await dualLogError("Failed to stop Browserless session:", error);
      return false;
    }
  }

  async unblockSite(
    url: string,
    options?: { requestBrowserEndpoint?: boolean }
  ): Promise<UnblockResult> {
    if (!this.token) {
      throw new Error("BROWSERLESS_TOKEN is not configured");
    }

    const timeout = parseInt(
      process.env.BROWSERLESS_UNBLOCK_TIMEOUT || "",
      10
    );
    const unblockTimeout =
      Number.isFinite(timeout) && timeout > 0 ? timeout : 5 * 60 * 1000;
    const queryParams = this.buildUnblockQueryParams(unblockTimeout);
    const requestBrowserEndpoint = options?.requestBrowserEndpoint ?? false;

    const response = await fetch(
      `${this.baseUrl}/chromium/unblock?${queryParams.toString()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          browserWSEndpoint: requestBrowserEndpoint,
          cookies: true,
          content: false,
          screenshot: false,
          ttl: Math.min(unblockTimeout, 300_000),
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Browserless unblock failed: ${response.status} ${errorText}`
      );
    }

    return (await response.json()) as UnblockResult;
  }

  async applyUnblockCookies(page: import("puppeteer").Page, url: string): Promise<boolean> {
    try {
      await dualLogInfo(`Applying Browserless unblock cookies for ${url}`);
      const result = await this.unblockSite(url, { requestBrowserEndpoint: false });

      if (!result.cookies?.length) {
        await dualLogInfo("Unblock returned no cookies; continuing without them");
        return false;
      }

      const puppeteerCookies = result.cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || "/",
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
      }));

      await page.setCookie(...puppeteerCookies);
      await dualLogInfo(`Applied ${puppeteerCookies.length} unblock cookies`);
      return true;
    } catch (error) {
      await dualLogError("Failed to apply unblock cookies:", error);
      return false;
    }
  }

  /** Unblock runs only when creating a new session, never on reuse. */
  shouldUseUnblock(isNewSession: boolean): boolean {
    if (!isNewSession) {
      return false;
    }
    return process.env.BROWSERLESS_USE_UNBLOCK !== "false";
  }

  async getOrCreateSessionForEmail(
    email: string,
    platform: PlatformsType = PlatformsType.BOOKING
  ): Promise<GetOrCreateSessionResult> {
    const normalizedEmail = this.normalizeEmail(email);
    const existing = await this.findActiveSession(normalizedEmail, platform);

    if (existing) {
      const session = this.toSessionResponse(existing);
      await this.touchSession(session.id);
      await dualLogInfo(
        `Reusing existing Browserless session for ${normalizedEmail}`,
        { sessionId: session.id }
      );
      return { session, isNew: false, reused: true };
    }

    const session = await this.createPersistentSession();
    await this.saveSession(normalizedEmail, session, platform);

    await dualLogInfo(
      `Created new Browserless session for ${normalizedEmail}`,
      { sessionId: session.id }
    );

    return { session, isNew: true, reused: false };
  }
}

export const browserlessSessionService = new BrowserlessSessionService();
