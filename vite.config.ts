/// <reference types="vitest/config" />
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// `npm run dev:phone` serves over HTTPS on your LAN so a phone can open the camera
// (browsers only allow camera access on https:// or localhost). Accept the self-signed
// certificate warning once on the phone.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'phone' ? [basicSsl()] : [],
  server: { port: 5174, host: mode === 'phone' ? true : undefined },
  build: { target: 'es2022' },
  test: { environment: 'node' },
}));
