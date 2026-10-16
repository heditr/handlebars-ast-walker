import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  treeshake: true,
  clean: true,
  splitting: false,
  target: "es2020",
  outDir: "dist",
});
