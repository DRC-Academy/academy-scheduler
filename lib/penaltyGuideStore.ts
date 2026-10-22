// ── Persistencia de la guía de penalizaciones ─────────────────────────────────
//
// Una sola escritura: el profesor pulsó "Entendido" en el último paso. Es lo que
// el admin ve en la pestaña Profesores ("Vio la guía") y lo que apaga el panel
// inferior en cualquier dispositivo, no solo en este navegador.
//
// Mismo criterio que lib/onboardingStore: no lanza. Si Supabase falla (o todavía
// no se corrió supabase-guia-penalizaciones.sql), el profesor sigue con su día;
// el panel se apaga en esta sesión por el estado local y volverá a salir mañana.
import { supabase } from '@/lib/supabase';

/** Marca la guía como terminada. No pisa la primera fecha si ya la tenía. */
export async function dbCompletePenaltyGuide(teacherId: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('teachers')
      .update({ penalty_guide_completed_at: new Date().toISOString() })
      .eq('id', teacherId)
      .is('penalty_guide_completed_at', null);
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('[guía penalizaciones] No se pudo registrar que terminó la guía:', e);
    return false;
  }
}
