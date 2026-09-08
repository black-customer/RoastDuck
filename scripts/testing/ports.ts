export function parseE2ePort(value: string | number | undefined): number {
  const text = String(value ?? 3100);
  if (!/^\d+$/.test(text) || Number(text) < 1024 || Number(text) > 65535) {
    throw new Error("ROASTDUCK_E2E_PORT 必须是 1024–65535 的整数");
  }
  return Number(text);
}

export function getE2ePort(env: Record<string, string | undefined> = process.env): number {
  return parseE2ePort(env.ROASTDUCK_E2E_PORT);
}
