export const configs = {
  headless_browser: false,
};

/** Default when ENVIRONMENT is unset: local PC with visible Chromium. */
const DEFAULT_ENVIRONMENT = "local";

export type AppEnvironment = "local" | "development" | "production" | "browserless";

export function getAppEnvironment(): AppEnvironment {
  const raw = (process.env.ENVIRONMENT || DEFAULT_ENVIRONMENT).toLowerCase();
  if (
    raw === "local" ||
    raw === "development" ||
    raw === "production" ||
    raw === "browserless"
  ) {
    return raw;
  }
  return DEFAULT_ENVIRONMENT;
}

/** Remote Browserless / cloud browser — only when ENVIRONMENT is production or browserless. */
export function useRemoteBrowser(): boolean {
  const env = getAppEnvironment();
  return env === "production" || env === "browserless";
}
