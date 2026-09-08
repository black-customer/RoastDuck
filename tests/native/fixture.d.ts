declare module "@native-fixture" {
  import type { SqlCommand } from "@/lib/platform/database";
  const commands:SqlCommand[];
  export default commands;
}
