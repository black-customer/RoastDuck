import type { NextConfig } from "next";

const desktopRelease = process.env.ROASTDUCK_DESKTOP_RELEASE;
if (desktopRelease && !/^[a-z0-9][a-z0-9-]{0,95}$/.test(desktopRelease)) throw new Error("Invalid desktop release ID");

const nextConfig: NextConfig = {
  devIndicators: false,
  distDir: process.env.ROASTDUCK_E2E === "1"
    ? ".next-e2e"
    : process.env.ROASTDUCK_DESKTOP === "1" ? desktopRelease ? `.next-desktop/releases/${desktopRelease}` : ".next-desktop" : ".next",
  ...(process.env.ROASTDUCK_DESKTOP === "1" && desktopRelease
    ? { typescript: { tsconfigPath: `.next-desktop/tsconfig-${desktopRelease}.json` } } : {}),
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
