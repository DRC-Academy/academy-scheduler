// ── El diploma del alumno, preguntado al LMS ─────────────────────────────────
//
// El LMS (drc-lms, otro proyecto y otra base) es quien sabe cuántas lecciones
// lleva un alumno de su curso. Expone GET /api/externo/diploma?alumno_id=<id>
// con un secreto compartido por cabecera, y esta función es la ÚNICA puerta de
// Gestión hacia él. La ficha de progreso enseña el resultado como una barra.
//
// BEST-EFFORT, SIEMPRE. El LMS tarda 1-1,5 s en caliente y 5-6 s en frío, y va a
// estar frío a menudo. La ficha se pinta entera sin esperar a esto y la barra
// llega después; si el LMS no responde, tarda de más, devuelve un error o algo
// con otra forma, aquí sale `null` y la ficha se queda sin barra. NUNCA lanza:
// un alumno no puede ver un error por un dato decorativo.
//
// CACHÉ DE 60 SEGUNDOS POR ALUMNO, en memoria del proceso. El dato solo cambia
// cuando el alumno completa una lección; una recarga de la ficha no tiene por
// qué despertar al LMS otra vez. Dos peticiones simultáneas del mismo alumno
// comparten una sola llamada. Los fallos no se cachean: la siguiente carga
// vuelve a intentar.
//
// EL SECRETO NO SALE DEL SERVIDOR. `server-only` rompe el build si esto se
// importa desde un componente cliente; las pantallas reciben el `Diploma` ya
// resuelto (por props, por una promesa, o por /api/progreso/diploma).

import 'server-only';
import type { Diploma } from '@/lib/diplomaTypes';

export type { Diploma, DiplomaEstado } from '@/lib/diplomaTypes';

/** Generoso a propósito: el arranque en frío es real y no bloquea nada visible. */
export const LMS_TIMEOUT_MS = 8_000;
export const LMS_CACHE_MS = 60_000;

/** Nombre de la cabecera que espera el LMS (lib/secreto-externo.ts allí). */
export const LMS_SECRET_HEADER = 'x-gestion-secret';

interface Entrada { valor: Diploma; vence: number }
const cache = new Map<string, Entrada>();
const enVuelo = new Map<string, Promise<Diploma | null>>();
/** El aviso de configuración se escribe una vez por proceso. */
let avisado = false;

/**
 * Valida la respuesta del LMS. Cualquier desvío de la forma acordada es `null`:
 * antes que pintar "NaN de undefined", no pintar nada.
 */
export function parseDiploma(raw: unknown): Diploma | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const estado = r.estado;
  if (estado !== 'en-curso' && estado !== 'conseguido' && estado !== 'sin-curso') return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
  const completadas = n(r.completadas), total = n(r.total), restantes = n(r.restantes);
  if (completadas === null || total === null || restantes === null) return null;
  let curso: Diploma['curso'] = null;
  if (r.curso !== null && r.curso !== undefined) {
    const c = r.curso as Record<string, unknown>;
    if (typeof c !== 'object' || typeof c.slug !== 'string' || typeof c.titulo !== 'string') return null;
    curso = { slug: c.slug, titulo: c.titulo };
  }
  return { estado, completadas, total, restantes, curso };
}

/** Lo inyectable, para los tests. En producción se usa todo por defecto. */
export interface LmsDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  url?: string | undefined;
  secret?: string | undefined;
  timeoutMs?: number;
}

/**
 * El diploma de `studentId` (el `id` de `students`), o `null` si no se pudo
 * saber. Ver la cabecera del módulo: nunca lanza.
 */
export function getLmsDiploma(studentId: string, deps: LmsDeps = {}): Promise<Diploma | null> {
  const now = deps.now ?? Date.now;
  const id = studentId.trim();
  if (!id) return Promise.resolve(null);

  const hit = cache.get(id);
  if (hit && hit.vence > now()) return Promise.resolve(hit.valor);

  const pendiente = enVuelo.get(id);
  if (pendiente) return pendiente;

  const p = pedir(id, deps)
    .then(valor => {
      if (valor) cache.set(id, { valor, vence: now() + LMS_CACHE_MS });
      return valor;
    })
    .catch(() => null)   // cinturón: `pedir` ya no lanza, pero el contrato es "nunca"
    .finally(() => { enVuelo.delete(id); });
  enVuelo.set(id, p);
  return p;
}

async function pedir(id: string, deps: LmsDeps): Promise<Diploma | null> {
  const url = (deps.url ?? process.env.LMS_URL ?? '').trim().replace(/\/+$/, '');
  const secret = (deps.secret ?? process.env.LMS_EXTERNAL_SECRET ?? '').trim();
  if (!url || !secret) {
    // Una vez por proceso alcanza: es configuración, no un fallo del alumno.
    if (!avisado) { avisado = true; console.warn('[lmsDiploma] Falta LMS_URL o LMS_EXTERNAL_SECRET: la ficha sale sin barra del diploma.'); }
    return null;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? LMS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${url}/api/externo/diploma?alumno_id=${encodeURIComponent(id)}`, {
      headers: { [LMS_SECRET_HEADER]: secret, accept: 'application/json' },
      signal: controller.signal,
      // Nunca por la caché de datos de Next: la caché de 60 s es la de arriba.
      cache: 'no-store',
    });
    if (!res.ok) {
      console.warn(`[lmsDiploma] El LMS respondió ${res.status} para el alumno ${id}.`);
      return null;
    }
    return parseDiploma(await res.json());
  } catch (err) {
    const motivo = err instanceof Error && err.name === 'AbortError' ? 'timeout' : (err instanceof Error ? err.message : String(err));
    console.warn(`[lmsDiploma] Sin respuesta del LMS para el alumno ${id} (${motivo}).`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Solo para los tests: deja el módulo como recién cargado. */
export function _resetLmsDiploma(): void {
  cache.clear();
  enVuelo.clear();
  avisado = false;
}
