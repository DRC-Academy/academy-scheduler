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

// ── Estados de WooCommerce Subscriptions ─────────────────────────────────────
//
// MAPA ÚNICO. Antes esto vivía repartido en cuatro sitios que no coincidían:
// el endpoint decidía con un `status === 'active'` suelto, y había tres funciones
// de badge distintas (useSubscriptionStatus, finance y attendance), la última de
// las cuales solo conocía 'active' y mandaba todo lo demás a "No verificado".
//
// `countsAsActive` es LO ÚNICO que decide si el alumno puede tomar clases. El
// caso que motivó el mapa es 'pending-cancel': el alumno canceló, pero pagó hasta
// el fin del periodo y sigue viniendo. Tratarlo como inactivo hacía saltar el
// popup a un alumno al día y marcaba sus clases como "sin suscripción" en
// finanzas.

export interface WooStatusMeta {
  /** Nombre real del estado, para el badge. Nunca "activa/inactiva" a secas. */
  label: string;
  /** ¿Puede tomar clases? */
  countsAsActive: boolean;
  /**
   * Emoji del badge. Vive acá y no en cada pantalla: era la última pieza del
   * estado que seguía duplicada. `useSubscriptionStatus.subBadge` y
   * `finance.subscriptionBadge` tenían cada una su propio ternario
   * (`countsAsActive ? '✅' : status === 'on-hold' ? '⚠️' : '❌'`), y ninguno de
   * los dos podía contemplar un estado nuevo sin tocarse por separado.
   */
  icon: string;
  color: string;
  bg: string;
}

export const WOO_STATUS: Record<string, WooStatusMeta> = {
  active: {
    label: 'Activa', countsAsActive: true, icon: '✅',
    color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)',
  },
  // Cuenta como activa: canceló la renovación, pero el periodo pagado sigue vivo.
  'pending-cancel': {
    label: 'Pendiente de cancelación', countsAsActive: true, icon: '⏳',
    color: '#b45309', bg: 'rgba(255,196,0,0.18)',
  },
  // SUSCRIPCIÓN PROGRAMADA: pagada, pero con fecha de inicio en el FUTURO. Hasta
  // que llegue esa fecha el alumno NO puede tomar clases, así que no cuenta como
  // activa.
  //
  // Auditoría 07/08/2026 sobre la instalación real (suscripción #33491 de Beatriz
  // Cuellar): status 'Scheduled', start_date 15/08, próximo pago 15/09, y una nota
  // del sistema del 06/07 registrando el paso de 'Activa' a 'Scheduled'. Es el
  // estado propio de la suscripción, no un dato de la próxima acción de pago: en
  // check-subscription solo se lee `subscription.status`, y la fecha del próximo
  // pago se lee aparte y únicamente alimenta `endDate`.
  //
  // Azul informativo, el mismo que Oritalk: no es un problema que haya que
  // resolver (como 'on-hold' o 'cancelled'), es una espera. Cuando llegue la
  // fecha WooCommerce lo pasa solo a 'active' y el alumno se activa sin que haya
  // que tocar nada acá.
  scheduled: {
    label: 'Programada', countsAsActive: false, icon: '🗓️',
    color: '#2563eb', bg: 'rgba(37,99,235,0.10)',
  },
  // PENDIENTE DE PAGO: la suscripción existe pero nunca se cobró. WooCommerce la
  // crea así al empezar el checkout y la pasa a 'active' cuando entra el pago, así
  // que lo que se acumula acá son sobre todo checkouts abandonados. NO da acceso.
  //
  // Estaba fuera del mapa hasta la auditoría del 28/08/2026: la instalación real
  // tenía 4 suscripciones en 'pending' y, al no ser clave de acá, caían en
  // `otros_estados` del endpoint externo (el dashboard las pintaba como "pending
  // (sin mapear)") y en el badge salían como "Sin verificar", que es justo lo que
  // no son — se sabe perfectamente qué les pasa.
  //
  // Mismo ámbar oscuro que 'on-hold' a propósito: los dos son "no da acceso y hay
  // algo que perseguir", y el color codifica qué hacer, no cuál es. Lo que los
  // separa de un vistazo es el icono (💳 pago que no entró vs ⚠️ pago que falló) y
  // el nombre, que es el que manda en este mapa.
  pending: {
    label: 'Pendiente de pago', countsAsActive: false, icon: '💳',
    color: '#92400e', bg: 'rgba(146,64,14,0.12)',
  },
  // Pago fallido o pausada: NO puede tomar clases. Ámbar oscuro para que se
  // distinga de un vistazo del ámbar de 'pending-cancel', que sí es válida.
  'on-hold': {
    label: 'En espera', countsAsActive: false, icon: '⚠️',
    color: '#92400e', bg: 'rgba(146,64,14,0.12)',
  },
  cancelled: {
    label: 'Cancelada', countsAsActive: false, icon: '❌',
    color: '#dc2626', bg: 'rgba(239,68,68,0.1)',
  },
  expired: {
    label: 'Vencida', countsAsActive: false, icon: '❌',
    color: '#dc2626', bg: 'rgba(239,68,68,0.1)',
  },
};

const UNKNOWN_STATUS: WooStatusMeta = {
  label: 'Sin verificar', countsAsActive: false, icon: '❓',
  color: 'var(--text-muted)', bg: 'var(--bg-surface-3)',
};

const NOT_FOUND_STATUS: WooStatusMeta = {
  label: 'No encontrada', countsAsActive: false, icon: '❓',
  color: 'var(--text-muted)', bg: 'var(--bg-surface-3)',
};

/**
 * Metadatos de un estado de WooCommerce. Un estado desconocido cae en "Sin
 * verificar" y NO cuenta como activo: ante la duda no se le abre la puerta a
 * nadie, pero tampoco se afirma que esté cancelado.
 *
 * El único canónico de WooCommerce Subscriptions que queda fuera del mapa es
 * 'switched' (la suscripción se cambió por otra). Hoy la instalación real tiene
 * cero, y por eso no se le inventa un tratamiento; si aparece, el endpoint
 * externo la reporta en `otros_estados` en vez de perderla, que es exactamente
 * cómo se detectó 'pending'. 'scheduled', en cambio, NO es canónico: lo agrega un
 * plugin de esta tienda y sí está mapeado.
 */
export function wooStatusMeta(status: string | null | undefined): WooStatusMeta {
  if (!status) return UNKNOWN_STATUS;
  if (status === 'not_found') return NOT_FOUND_STATUS;
  return WOO_STATUS[status] ?? UNKNOWN_STATUS;
}

/** ¿Este estado de WooCommerce permite tomar clases? active y pending-cancel sí. */
export function isActiveWooStatus(status: string | null | undefined): boolean {
  return wooStatusMeta(status).countsAsActive;
}

/**
 * ¿La suscripción está PROGRAMADA y todavía no empezó?
 *
 * No es "inactiva" en el sentido de las otras: el alumno pagó y va a empezar. Lo
 * que cambia es la acción del equipo (esperar, no recuperar), y por eso tiene
 * badge propio, categoría propia en los filtros y su propio aviso al ingresar.
 */
export function isScheduledWooStatus(status: string | null | undefined): boolean {
  return status === 'scheduled';
}

/** Estados que permiten tomar clases, en el orden en que se prefieren cuando un
 *  alumno tiene varias suscripciones. */
export const ACTIVE_WOO_STATUSES = Object.keys(WOO_STATUS).filter(s => WOO_STATUS[s].countsAsActive);
