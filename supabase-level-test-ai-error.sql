-- Prueba de nivel: guarda el error REAL de la IA cuando no puede evaluar la
-- redacción (antes solo quedaba invalid_reason = 'ai_unavailable' y el motivo
-- había que buscarlo en los logs de Vercel). Ejemplo: el saldo agotado de
-- Anthropic del 14–16/09/2026.
-- Corrido a mano en Supabase el 25/09/2026. Idempotente.

alter table level_test_answers
  add column if not exists ai_error text;
