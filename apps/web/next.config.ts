import path from "node:path";

import type { NextConfig } from "next";

import { loadEnvFile } from "./src/lib/load-env-file";

// All services share one .env at the repo root (see .env.example). Next.js only
// reads .env files from its own directory, so load the root one here, before
// Next compiles anything and inlines NEXT_PUBLIC_* values. Resolved from this
// file's location so it doesn't depend on the directory `next` was started in.
// Variables already set in the real environment (CI, Vercel) still win.
loadEnvFile(path.resolve(import.meta.dirname, "../../.env"));

const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      // Tailwind v4's Turbopack loader (from create-next-app), used in place of
      // the PostCSS plugin so CSS is compiled by Turbopack directly.
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
