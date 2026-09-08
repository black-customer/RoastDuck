import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  distDir: process.env.ROASTDUCK_E2E === "1"
    ? ".next-e2e"
    : process.env.ROASTDUCK_DESKTOP === "1" ? ".next-desktop" : ".next",
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
