import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "file:.data/tetra-pglite",
      AUTH_SECRET: process.env.AUTH_SECRET ?? "test-secret-0123456789abcdef",
      DEFAULT_TIMEZONE: "Asia/Jakarta",
      ALLOW_DEV_LOGIN: "true",
      // Never let tests reach real Google Sheets/Calendar, even with a populated .env.local.
      GOOGLE_SPREADSHEET_ID: "",
      GOOGLE_SHEET_NAME: "",
      GOOGLE_SHEET_GID: "",
      SHEET_MAPPING_FORMAT: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "",
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "",
    },
  },
});
