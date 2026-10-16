// ── Secciones de /admin: la lista ÚNICA ───────────────────────────────────────
//
// Qué secciones hay, cómo se llaman, en qué grupo van, cuáles están ocultas y
// qué contador lleva cada una. La leen las dos navegaciones del admin:
//
//   · components/admin/AdminSeccionMenu.tsx  desplegable de escritorio (≥ 768 px)
//   · components/admin/AdminNavMovil.tsx     barra inferior + "Más" del teléfono
//
// Una sección nueva se agrega UNA vez acá (y su contenido en app/admin/page.tsx);
// las dos navegaciones la muestran igual, en el mismo grupo y con el mismo nombre.

/** Ids de las secciones, en el orden histórico de las pestañas. */
export const ADMIN_TAB_IDS = [
  'teachers', 'emails', 'scoring', 'bonos', 'tracking', 'fueracal', 'classlog', 'transcripts',
  'leveltests', 'validacion', 'recuperaciones', 'ai', 'aiusage', 'bajas', 'testimoniales', 'notifications',
] as const;

export type AdminTabId = typeof ADMIN_TAB_IDS[number];

export function isAdminTabId(v: string | null | undefined): v is AdminTabId {
  return !!v && (ADMIN_TAB_IDS as readonly string[]).includes(v);
}

/**
 * Secciones que existen (código, datos y cron siguen ahí) pero NO se muestran,
 * ni en el desplegable de escritorio ni en el "Más" del teléfono ni por ?tab=.
 * "Bajas" se ocultó en septiembre de 2026 a pedido de Facundo: en fase de
 * recopilación no aportaba nada y no se entendía. "Seguimiento" y "Fuera de
 * calendario" se ocultaron el 16/10/2026, también a pedido de Facundo. Para
 * reactivar una sección, basta con quitarla de acá.
 */
export const SECCIONES_OCULTAS: ReadonlySet<AdminTabId> = new Set<AdminTabId>(['bajas', 'tracking', 'fueracal']);

/** Contadores de pendientes. null = todavía cargando (se muestra sin número). */
export interface AdminContadores {
  validacion: number;
  /** Ámbar cuando la cola lleva días; gris si es reciente. */
  validacionUrgente: boolean;
  riesgo: number | null;
  /** Asignaciones activas sin enlace de clase con más de 24 h (lib/meetLinkStatus). */
  emails: number;
  proximosACancelar: number;
}

export type TonoContador = 'rojo' | 'ambar' | 'gris';

/** El contador de una sección (o del enlace de Próximos a cancelar), o null si no lleva. */
export function contadorDe(id: string, c: AdminContadores): { n: number | null; tono: TonoContador } | null {
  switch (id) {
    case 'validacion': return { n: c.validacion, tono: c.validacionUrgente ? 'ambar' : 'gris' };
    case 'ai':         return { n: c.riesgo, tono: 'rojo' };
    case 'emails':     return { n: c.emails, tono: 'rojo' };
    case 'proximos':   return { n: c.proximosACancelar, tono: 'ambar' };
    default:           return null;
  }
}

// ─── Las secciones, agrupadas por tema ───────────────────────────────────────
// "Próximos a cancelar" es una ruta aparte (/proximos-cancelar), pero para el
// admin es una sección más de Alumnos: va en el grupo como ENLACE (`href`).

export interface SeccionAdmin { id: AdminTabId | 'proximos'; label: string; href?: string }

export const GRUPOS_ADMIN: ReadonlyArray<{ nombre: string; secciones: SeccionAdmin[] }> = [
  { nombre: 'Alumnos', secciones: [
    { id: 'tracking', label: 'Seguimiento' },
    { id: 'fueracal', label: 'Fuera de calendario' },
    { id: 'leveltests', label: 'Tests de nivel' },
    { id: 'ai', label: 'Riesgo' },
    { id: 'proximos', label: 'Próximos a cancelar', href: '/proximos-cancelar' },
    { id: 'bajas', label: 'Bajas' },
    { id: 'testimoniales', label: 'Testimoniales' },
  ] },
  { nombre: 'Profesores', secciones: [
    { id: 'teachers', label: 'Profesores' },
    { id: 'scoring', label: 'Scoring' },
    { id: 'bonos', label: 'Bonos' },
    { id: 'aiusage', label: 'Uso de IA' },
  ] },
  { nombre: 'Clases', secciones: [
    { id: 'classlog', label: 'Registro de clases' },
    { id: 'transcripts', label: 'Transcripts' },
    { id: 'validacion', label: 'Validación' },
    { id: 'recuperaciones', label: 'Recuperaciones' },
  ] },
  { nombre: 'Avisos', secciones: [
    { id: 'emails', label: 'Enlaces' },
    { id: 'notifications', label: 'Notificaciones' },
  ] },
];

/** ¿Se muestra? Las ocultas no; el enlace de Próximos a cancelar, siempre. */
export function seccionVisible(s: SeccionAdmin): boolean {
  return !!s.href || !SECCIONES_OCULTAS.has(s.id as AdminTabId);
}

export const GRUPO_DE: Record<string, string> =
  Object.fromEntries(GRUPOS_ADMIN.flatMap(g => g.secciones.map(s => [s.id, g.nombre])));
export const LABEL_DE: Record<string, string> =
  Object.fromEntries(GRUPOS_ADMIN.flatMap(g => g.secciones.map(s => [s.id, s.label])));
