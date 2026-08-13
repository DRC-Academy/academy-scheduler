// ── Persistencia del onboarding automático ────────────────────────────────────
//
// Tres escrituras sobre `teachers`, todas del modo AUTOMÁTICO. El botón "Tutorial"
// del header no escribe nada: abrirlo y cerrarlo no deja rastro ni consume la
// formación de nadie.
//
// Ninguna de estas funciones lanza: el tutorial es una ayuda, y si Supabase falla
// (o todavía no se corrió supabase-onboarding.sql y las columnas no existen) el
// profesor tiene que poder seguir dando su clase igual. El recorrido en pantalla
// avanza con su propio estado local, así que un fallo acá se nota como mucho al
// recargar la página.
import { supabase } from '@/lib/supabase';
import { ONBOARDING_TARGET_CLASSES } from '@/lib/onboarding';

/** Marca cuándo se le mostró el tutorial por primera vez. No pisa el valor ya escrito. */
export async function dbStartOnboarding(teacherId: string): Promise<void> {
  try {
    await supabase
      .from('teachers')
      .update({ onboarding_started_at: new Date().toISOString() })
      .eq('id', teacherId)
      .is('onboarding_started_at', null);
  } catch (e) {
    console.error('[onboarding] No se pudo registrar el inicio de la formación:', e);
  }
}

/**
 * "Saltar tutorial": termina el onboarding AUTOMÁTICO.
 *
 * No borra el progreso (`onboarding_classes_completed` queda como está) porque es
 * el historial de lo que el profesor sí llegó a hacer, y no toca nada del botón
 * del header, que sigue disponible.
 */
export async function dbSkipOnboarding(teacherId: string): Promise<void> {
  try {
    await supabase.from('teachers').update({ onboarding_active: false }).eq('id', teacherId);
  } catch (e) {
    console.error('[onboarding] No se pudo saltar la formación:', e);
  }
}

export interface OnboardingProgress {
  classesCompleted: number;
  /** true si esta clase fue la última: la formación acaba de terminar. */
  finished: boolean;
}

/**
 * Suma una clase de formación (el profesor entró Y subió el transcript) y, si con
 * esa llegó a la quinta, apaga el automático en la misma escritura.
 *
 * `expected` es el contador que tenía el cliente: la escritura se condiciona a él
 * (`.eq`), así que dos pestañas abiertas no pueden sumar dos veces la misma clase.
 * Si la condición no coincide, la fila no se toca y se devuelve el valor local sin
 * incrementar.
 */
export async function dbCompleteOnboardingClass(
  teacherId: string,
  expected: number,
): Promise<OnboardingProgress> {
  const next = expected + 1;
  const finished = next >= ONBOARDING_TARGET_CLASSES;

  try {
    const { data, error } = await supabase
      .from('teachers')
      .update({
        onboarding_classes_completed: next,
        // La bandera se apaga en la MISMA escritura que la quinta clase: si fueran
        // dos, un fallo entre medio dejaría al profesor con el contador lleno y el
        // tutorial todavía encendido.
        ...(finished ? { onboarding_active: false } : {}),
      })
      .eq('id', teacherId)
      .eq('onboarding_classes_completed', expected)
      .select('onboarding_classes_completed');

    if (error) throw error;
    // Sin filas afectadas: otra pestaña ya contó esta clase.
    if (!data || data.length === 0) return { classesCompleted: expected, finished: false };
    return { classesCompleted: next, finished };
  } catch (e) {
    console.error('[onboarding] No se pudo registrar la clase de formación:', e);
    return { classesCompleted: expected, finished: false };
  }
}
