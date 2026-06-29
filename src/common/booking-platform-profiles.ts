export type BrowserPlatform = "mac" | "win" | "linux";

export interface HardwareBundle {
  screenWidth: number;
  screenHeight: number;
  screenAvailHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  webglVendor: string;
  webglRenderer: string;
  uaArchitecture: "x86" | "arm";
  hardwareConcurrency: number;
  deviceMemory: number;
  connectionType: "wifi" | "ethernet";
}

export interface PlatformTemplate {
  userAgent: string;
  navigatorPlatform: string;
  secChUaPlatform: string;
  uaDataPlatform: string;
  platformVersion: string;
  hardwareProfiles: HardwareBundle[];
}

export const PLATFORM_TEMPLATES: Record<BrowserPlatform, PlatformTemplate> = {
  mac: {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: '"macOS"',
    uaDataPlatform: "macOS",
    platformVersion: "15.2.0",
    hardwareProfiles: [
      {
        screenWidth: 2560,
        screenHeight: 1440,
        screenAvailHeight: 1415,
        viewportWidth: 1920,
        viewportHeight: 1080,
        devicePixelRatio: 2,
        webglVendor: "Apple Inc.",
        webglRenderer: "Apple M1 Pro",
        uaArchitecture: "arm",
        hardwareConcurrency: 10,
        deviceMemory: 16,
        connectionType: "wifi",
      },
      {
        screenWidth: 1920,
        screenHeight: 1080,
        screenAvailHeight: 1055,
        viewportWidth: 1905,
        viewportHeight: 945,
        devicePixelRatio: 2,
        webglVendor: "Intel Inc.",
        webglRenderer: "Intel Iris OpenGL Engine",
        uaArchitecture: "x86",
        hardwareConcurrency: 8,
        deviceMemory: 8,
        connectionType: "wifi",
      },
      {
        screenWidth: 1512,
        screenHeight: 982,
        screenAvailHeight: 957,
        viewportWidth: 1512,
        viewportHeight: 900,
        devicePixelRatio: 2,
        webglVendor: "Apple Inc.",
        webglRenderer: "Apple M3",
        uaArchitecture: "arm",
        hardwareConcurrency: 12,
        deviceMemory: 16,
        connectionType: "wifi",
      },
    ],
  },
  win: {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    navigatorPlatform: "Win32",
    secChUaPlatform: '"Windows"',
    uaDataPlatform: "Windows",
    platformVersion: "15.0.0",
    hardwareProfiles: [
      {
        screenWidth: 1920,
        screenHeight: 1080,
        screenAvailHeight: 1040,
        viewportWidth: 1905,
        viewportHeight: 945,
        devicePixelRatio: 1,
        webglVendor: "Google Inc. (Intel)",
        webglRenderer:
          "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        uaArchitecture: "x86",
        hardwareConcurrency: 8,
        deviceMemory: 8,
        connectionType: "wifi",
      },
      {
        screenWidth: 2560,
        screenHeight: 1440,
        screenAvailHeight: 1400,
        viewportWidth: 1920,
        viewportHeight: 1080,
        devicePixelRatio: 1,
        webglVendor: "Google Inc. (NVIDIA)",
        webglRenderer:
          "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        uaArchitecture: "x86",
        hardwareConcurrency: 12,
        deviceMemory: 16,
        connectionType: "ethernet",
      },
      {
        screenWidth: 1680,
        screenHeight: 1050,
        screenAvailHeight: 1010,
        viewportWidth: 1680,
        viewportHeight: 962,
        devicePixelRatio: 1,
        webglVendor: "Google Inc. (AMD)",
        webglRenderer:
          "ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)",
        uaArchitecture: "x86",
        hardwareConcurrency: 8,
        deviceMemory: 8,
        connectionType: "wifi",
      },
    ],
  },
  linux: {
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    navigatorPlatform: "Linux x86_64",
    secChUaPlatform: '"Linux"',
    uaDataPlatform: "Linux",
    platformVersion: "6.5.0",
    hardwareProfiles: [
      {
        screenWidth: 1920,
        screenHeight: 1080,
        screenAvailHeight: 1050,
        viewportWidth: 1920,
        viewportHeight: 969,
        devicePixelRatio: 1,
        webglVendor: "Intel",
        webglRenderer: "Mesa Intel(R) UHD Graphics 620 (KBL GT2)",
        uaArchitecture: "x86",
        hardwareConcurrency: 8,
        deviceMemory: 8,
        connectionType: "ethernet",
      },
      {
        screenWidth: 2560,
        screenHeight: 1440,
        screenAvailHeight: 1410,
        viewportWidth: 1920,
        viewportHeight: 1080,
        devicePixelRatio: 1,
        webglVendor: "NVIDIA Corporation",
        webglRenderer: "NVIDIA GeForce GTX 1660/PCIe/SSE2",
        uaArchitecture: "x86",
        hardwareConcurrency: 12,
        deviceMemory: 16,
        connectionType: "ethernet",
      },
      {
        screenWidth: 1680,
        screenHeight: 1050,
        screenAvailHeight: 1020,
        viewportWidth: 1680,
        viewportHeight: 962,
        devicePixelRatio: 1,
        webglVendor: "Intel",
        webglRenderer: "Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2)",
        uaArchitecture: "x86",
        hardwareConcurrency: 8,
        deviceMemory: 8,
        connectionType: "wifi",
      },
    ],
  },
};
