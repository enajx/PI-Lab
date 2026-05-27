import { defineConfig } from "drizzle-kit"

// Drizzle Kit only generates SQL artifacts here; it never opens the runtime DB
// (that lives at $SKIPPER_DATA_DIR/local.db and is reached via `migrate.ts`).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/tables.ts",
  out: "./drizzle",
})
