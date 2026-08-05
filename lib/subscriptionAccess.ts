// ── Regla ÚNICA de "alumno activo" ───────────────────────────────────────────
//
// Un alumno está ACTIVO si se cumple cualquiera de estas tres:
//
//   1. Tiene una suscripción de WooCommerce en estado 'active'.
//   2. Tiene una activación manual vigente  (students.manual_active_until).
//   3. Es alumno de Oritalk vigente         (students.is_oritalk + oritalk_until).
//
// Las dos últimas son OVERRIDES: se deciden en nuestra base y NO dependen de
// WooCommerce, así que valen aunque la API de Woo esté caída o el alumno no
// tenga ningún producto comprado (que es justo el caso de Oritalk: se marca a
// alumnos que aparecen como "Sin verificar").
//
// Este módulo es PURO a propósito (no importa nada, no toca red ni base): lo usa
// el servidor en /api/check-subscription, que es el único sitio donde se decide
// `active`. De ahí, el mismo booleano viaja a TODA la app a través de
// lib/useSubscriptionStatus:
//
//   · el badge lo pinta subBadge()
//   · la categoría de los filtros la da subCategory()
//   · el popup de "Ingresar a clase" mira `info.active === true` (JoinClass)
//
// Es decir: hay UNA sola definición de activo y siete pantallas que la leen. Si
// mañana aparece un cuarto origen, se añade acá y no hay que tocar ninguna vista.

/** Orden de precedencia entre overrides. Oritalk gana: es una decisión explícita
 *  del admin y además tiene badge propio, así que no puede quedar tapada por una
 *  activación manual que hubiera de antes. */
export type OverrideKind = 'oritalk' | 'manual';

export interface AccessOverride {
  kind: OverrideKind;
  /** 'YYYY-MM-DD' — último día INCLUIDO. */
  until: string;
}

/** Fila de `students` en lo que respecta al acceso. Campos opcionales: las
 *  columnas de Oritalk pueden no existir todavía (migración sin correr). */
export interface AccessRow {
  manual_active_until?: string | null;
  is_oritalk?: boolean | null;
  oritalk_until?: string | null;
}

/** Hoy en hora de España ('YYYY-MM-DD'). Las clases son en Europe/Madrid, así que
 *  una fecha de fin vence cuando allí cambia el día, no cuando cambia en el
 *  servidor (que corre en UTC) ni en Argentina, donde están los profesores. */
export function madridToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** ¿La fecha de fin sigue vigente? El último día cuenta como activo. */
export function isUntilActive(until: string | null | undefined, today: string): boolean {
  return !!until && until >= today;
}

/**
 * El override vigente del alumno, si lo hay. null → hay que preguntarle a
 * WooCommerce.
 *
 * `is_oritalk` sin fecha NO activa a nadie: el modal siempre pide una, y sin
 * fecha no habría forma de que el estado caducara solo.
 */
export function accessOverrideOf(row: AccessRow | null | undefined, today: string): AccessOverride | null {
  if (!row) return null;
  if (row.is_oritalk && isUntilActive(row.oritalk_until, today)) {
    return { kind: 'oritalk', until: row.oritalk_until as string };
  }
  if (isUntilActive(row.manual_active_until, today)) {
    return { kind: 'manual', until: row.manual_active_until as string };
  }
  return null;
}

/** ¿El alumno es de Oritalk y sigue vigente? Atajo para el panel de alumnos, que
 *  ya tiene la fila cargada y no necesita consultar la suscripción para saberlo. */
export function isOritalkActive(row: AccessRow | null | undefined, today = madridToday()): boolean {
  return accessOverrideOf(row, today)?.kind === 'oritalk';
}
