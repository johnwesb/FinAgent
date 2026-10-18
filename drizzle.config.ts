import "dotenv/config";
import type { Config } from "drizzle-kit";

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    "DATABASE_URL is required — create a .env in the project root (see SETUP.md §4)",
  );
}

export default {
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  dbCredentials: { url },
} satisfies Config;
