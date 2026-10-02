// Respuestas HTTP comunes de las rutas de recuperaciones (profesor y LMS).
// Cuerpo de error del contrato: { error: '<codigo>', mensaje: '<texto>' }.

import 'server-only';

import { RecoveryError } from '@/lib/classRecoveryStore';

export function recoveryErrorResponse(err: unknown, label: string): Response {
  if (err instanceof RecoveryError) {
    return Response.json({ error: err.code, mensaje: err.message }, { status: err.status, headers: { 'Cache-Control': 'no-store' } });
  }
  console.error(`[${label}]`, err);
  return Response.json(
    { error: 'error', mensaje: err instanceof Error ? err.message : 'Error inesperado.' },
    { status: 500, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function readJson<T>(request: Request): Promise<T | null> {
  try { return (await request.json()) as T; } catch { return null; }
}
