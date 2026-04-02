import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import mkcert from "vite-plugin-mkcert";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), mkcert()],
  resolve: {
    alias: [
      {
        find: /^@bufbuild\/protobuf$/,
        replacement: fileURLToPath(
          new URL(
            "./node_modules/@bufbuild/protobuf/dist/esm/index.js",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^@bufbuild\/protobuf\/(.*)$/,
        replacement:
          fileURLToPath(
            new URL(
              "./node_modules/@bufbuild/protobuf/dist/esm/",
              import.meta.url,
            ),
          ) + "$1/index.js",
      },
    ],
  },
  server: {
    fs: {
      allow: [
        fileURLToPath(new URL(".", import.meta.url)),
        fileURLToPath(new URL("../runtime", import.meta.url)),
      ],
    },
    https: {},
  },
});
