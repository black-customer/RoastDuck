import type { CapacitorConfig } from "@capacitor/cli";

// Production uses bundled pages. The explicit debug harness never becomes a fallback UI.
const harness = process.env.ROASTDUCK_NATIVE_HARNESS === "1";
const qa=process.env.ROASTDUCK_MOBILE_QA==="1";

const config: CapacitorConfig = {
  appId: "com.roastduck.app",
  appName: "鱼块学英语",
  webDir: harness ? "test-results/native-harness" : qa?"test-results/mobile-test-dist":"mobile/dist",
  loggingBehavior: harness||qa ? "debug" : "none",
  server: {
    androidScheme: "https",
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
    backgroundColor: "#f8fafc",
  },
};

export default config;
