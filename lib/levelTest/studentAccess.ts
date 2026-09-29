// ¿Puede este alumno abrir su prueba de nivel? (servidor)
//
// Desde el 28/09/2026 la prueba de un alumno no caduca por fecha: vale mientras
// el alumno esté ACTIVO. "Activo" es la regla única de lib/subscriptionAccess
// (Woo activo, activación manual u Oritalk), que solo se calcula en
// /api/check-subscription. Aquí se llama a esa MISMA función (su GET, en
// memoria, sin salir a la red) para no tener una segunda definición de activo.
//
// Decisiones (Facundo, 28/09/2026):
//   · active === true             → puede.
//   · WooCommerce no contesta     → puede. Que no se quede fuera por un fallo
//     (active === null)              nuestro.
//   · Woo no lo encuentra, o el   → puede SI tiene una asignación activa (email
//     alumno no tiene email          distinto en la tienda, empresas…).
//   · cualquier otro "no activo"  → no puede (cancelado, en espera, caducado…).

import { supabase } from '@/lib/supabase';
import { GET as checkSubscription } from '@/app/api/check-subscription/route';

async function hasActiveAssignment(studentId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('assignments').select('status').eq('student_id', studentId);
  if (error) {
    console.error('[studentAccess] No se pudieron leer las asignaciones:', error);
    return true;   // ante la duda, no bloquear
  }
  // Sin la columna status (migración antigua) toda asignación cuenta como activa.
  return (data ?? []).some(a => a.status == null || a.status === 'active');
}

export async function canTakeLevelTest(studentId: string): Promise<boolean> {
  const { data: student, error } = await supabase
    .from('students').select('id, email').eq('id', studentId).maybeSingle();
  if (error) {
    console.error('[studentAccess] No se pudo leer el alumno:', error);
    return true;   // ante la duda, no bloquear
  }

  const email = (student?.email as string | null | undefined)?.trim().toLowerCase();
  if (!email) return hasActiveAssignment(studentId);

  let result: { active?: boolean | null; status?: string } = {};
  try {
    const res = await checkSubscription(
      new Request(`http://interno/api/check-subscription?email=${encodeURIComponent(email)}`),
    );
    result = await res.json();
  } catch (e) {
    console.error('[studentAccess] Falló la comprobación de suscripción:', e);
    return true;
  }

  if (result.active === true) return true;
  if (result.active == null) return true;
  if (result.status === 'not_found') return hasActiveAssignment(studentId);
  return false;
}
