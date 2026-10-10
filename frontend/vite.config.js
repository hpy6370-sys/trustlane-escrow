import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: { ethers: ["ethers"], charts: ["recharts"], react: ["react", "react-dom", "react-router-dom"] },
      },
    },
  },
});
