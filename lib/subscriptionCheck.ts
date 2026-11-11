// Verificación de la suscripción de un alumno DESDE EL SERVIDOR (crons). SOLO SERVIDOR.
//
// Es la misma pregunta que hace el botón "Ingresar a clase": la ruta
// /api/check-subscription (Oritalk, activación manual y Woo, en ese orden),
// llamada en el mismo proceso, sin salir a la red. Así un cron no puede tener su
// propia idea de quién está activo.
//
// La usan el aviso de posible falta del profesor (lib/teacherAbsenceStore) y el
// de "tu plan ha finalizado" (lib/endedPlanJob). Hasta nov/2026 vivía dentro del
// primero.

import { GET as checkSubscriptionRoute } from '@/app/api/check-subscription/route';

export interface VerificacionSuscripcion {
  /** null = no se pudo verificar (Woo caído, error): quien llama decide, nunca "inactivo". */
  active: boolean | null;
  /** El `status` de check-subscription ('active', 'cancelled', 'manual_override', 'error'…). */
  status: string;
  phone: string | null;
}

/** Nunca lanza: ante cualquier fallo, `active: null`. */
export async function verificarSuscripcion(email: string, label = 'suscripcion'): Promise<VerificacionSuscripcion> {
  try {
    const res = await checkSubscriptionRoute(new Request(`http://gestion.local/api/check-subscription?email=${encodeURIComponent(email)}`));
    const j = (await res.json()) as Record<string, unknown>;
    return {
      active: typeof j.active === 'boolean' ? j.active : null,
      status: typeof j.status === 'string' ? j.status : 'error',
      phone: typeof j.phone === 'string' ? j.phone : null,
    };
  } catch (err) {
    console.error(`[${label}] No se pudo verificar la suscripción:`, err);
    return { active: null, status: 'error', phone: null };
  }
}
