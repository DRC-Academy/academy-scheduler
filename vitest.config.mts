import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Primer runner de tests del proyecto. Alcance deliberadamente chico: la lógica
// PURA (sin red ni base) de lib/. No hay entorno de navegador ni mocks de
// Supabase; si un módulo necesita eso, es que no es candidato a esta suite.
export default defineConfig({
  resolve: {
    // Mismo alias que tsconfig.json ("@/*" → "./*").
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
    // lib/supabase.ts crea el cliente al importarse y revienta sin estas
    // variables. Son de mentira a propósito: aquí no se toca la red, solo se
    // prueban funciones puras de módulos que arrastran ese import.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
    },
  },
});
