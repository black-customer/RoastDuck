import type { Metadata, Viewport } from "next";
import "./globals.css";
import './web-usability.css';
import { AppShell } from "@/components/ui/AppShell";

export const metadata: Metadata = {
  title: "鱼块学英语",
  description: "从自己的雅思回答中找到值得学习的表达，轻松学习并按时复习。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-dvh antialiased"><AppShell>{children}</AppShell></body>
    </html>
  );
}
