// @vitest-environment jsdom
// @vitest-environment-options {"pretendToBeVisual": true, "url": "http://localhost/"}
//
// ── Ninguna pantalla relanza sus cargas en bucle ─────────────────────────────
//
// El 08/10/2026 la ficha del alumno relanzaba loadClassJoinLogs sin fin (un
// efecto con [loadClassJoinLogs] y un proveedor que recreaba sus funciones en
// cada render) y, con varios profesores con la ficha abierta, saturó la base.
//
// Este test monta la app DE VERDAD (Providers del layout + la página, con su
// NavBar) en un navegador simulado y cuenta las peticiones HTTP que salen hacia
// Supabase, por tabla, como las vería pg_stat_statements. Lo único falso es la
// red: `fetch` responde con una base mínima (un profesor, una alumna, su clase).
// Luego deja pasar 5 minutos de reloj, con la recarga de cada 60 s incluida.
//
// Falla si una tabla que NO es de la recarga periódica (class_join_logs,
// calendar_changes, student_profiles…) se vuelve a pedir pasados los primeros
// segundos, o si cualquier tabla supera un tope que solo un bucle alcanza.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const nav = vi.hoisted(() => ({ pathname: '/', params: {} as Record<string, string> }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {}, prefetch: () => {} }),
  usePathname: () => nav.pathname,
  useParams: () => nav.params,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: unknown; children?: ReactNode } & Record<string, unknown>) =>
    <a href={String(href)} {...(rest as object)}>{children}</a>,
}));

// ── La base de mentira ───────────────────────────────────────────────────────

const HOY = new Date('2026-10-14T10:00:00Z');   // miércoles

const BASE: Record<string, unknown[]> = {
  teachers: [{ id: 't1', name: 'Profe Prueba', email: 'profe@x.com', specialties: [], rating: 5 }],
  teacher_calendars: [{ teacher_id: 't1', grid: { 'Lunes_17:00': { state: 'ocupado', student: 'Ana Prueba' } } }],
  students: [{ id: 's1', name: 'Ana Prueba', email: 'ana@x.com', level: 'B1', plan: 'Inglés general' }],
  assignments: [{
    id: 'a1', teacher_id: 't1', teacher_name: 'Profe Prueba', teacher_email: 'profe@x.com',
    student_id: 's1', student_name: 'Ana Prueba', student_email: 'ana@x.com', student_level: 'B1',
    slots: [{ day: 'Lunes', hour: '17:00' }], weekly_hours: 1, start_date: '2026-09-01',
    created_at: '2026-09-01T00:00:00Z', status: 'active', meet_link: 'https://meet.example/abc',
  }],
  class_join_logs: [{
    id: 'j1', teacher_id: 't1', teacher_name: 'Profe Prueba', student_name: 'Ana Prueba',
    scheduled_date: '2026-10-12', scheduled_time: '17:00', clicked_at: '2026-10-12T14:58:00Z', punctuality: 'puntual',
  }],
  student_profiles: [{ student_id: 's1', student_name: 'Ana Prueba', teacher_id: 't1' }],
  calendar_changes: [{
    teacher_id: 't1', student_name: 'Ana Prueba', day: 'Lunes', hour: '17:00', action: 'agregado',
    created_at: '2026-09-29T10:00:00Z',
  }],
};

/** Peticiones por tabla (o rpc/<función>, o /api/<ruta>). */
let peticiones: Map<string, number>;

function responder(url: URL, init: RequestInit | undefined): Response {
  const metodo = (init?.method ?? 'GET').toUpperCase();
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });

  // Rutas /api de la app: la suscripción responde "activa"; el resto, un 503
  // (todas son best-effort y la pantalla sigue sin ellas).
  if (url.pathname === '/api/check-subscription') return json({ status: 'active' });
  if (!url.pathname.startsWith('/rest/v1/')) return json({ error: 'sin red en el test' }, 503);
  const recurso = url.pathname.slice('/rest/v1/'.length);
  if (recurso.startsWith('rpc/')) return json([]);
  if (metodo !== 'GET' && metodo !== 'HEAD') return json([], 201);

  const filas = BASE[recurso] ?? [];
  const cabeceras = new Headers(init?.headers);
  if ((cabeceras.get('accept') ?? '').includes('vnd.pgrst.object')) {
    // .single() / .maybeSingle(): una fila o el 406 de PostgREST.
    return filas.length === 1
      ? json(filas[0])
      : json({ code: 'PGRST116', details: 'The result contains 0 rows', hint: null, message: 'JSON object requested, multiple (or no) rows returned' }, 406);
  }
  return json(filas, 200, { 'content-range': `0-${Math.max(filas.length - 1, 0)}/${filas.length}` });
}

function clave(url: URL): string {
  if (url.pathname.startsWith('/rest/v1/')) return url.pathname.slice('/rest/v1/'.length);
  return url.pathname;
}

// ── Montaje ──────────────────────────────────────────────────────────────────

let root: Root | null = null;
let contenedor: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers({ now: HOY, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  peticiones = new Map();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    peticiones.set(clave(url), (peticiones.get(clave(url)) ?? 0) + 1);
    return responder(url, init);
  }));
  // El canal en vivo de la campana (Supabase Realtime) no tiene a quién llamar.
  vi.stubGlobal('WebSocket', class { readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} });
  localStorage.setItem('academy_user', JSON.stringify({
    id: 'u1', username: 'profe', password: '', role: 'teacher', teacherId: 't1', displayName: 'Profe Prueba',
  }));
  contenedor = document.createElement('div');
  document.body.appendChild(contenedor);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  contenedor.remove();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function avanzar(ms: number) {
  // De a 1 s: cada tramo deja correr las respuestas y los renders que provocan.
  for (let t = 0; t < ms; t += 1_000) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(1_000, ms - t)); });
  }
}

const foto = () => Object.fromEntries(peticiones);

/** Monta la pantalla, la deja cargar y después la deja abierta 5 minutos. */
async function abrirCincoMinutos(pagina: () => Promise<{ default: () => ReactNode }>, ruta: string, params: Record<string, string> = {}) {
  nav.pathname = ruta;
  nav.params = params;
  const [{ Providers }, { default: Pagina }] = await Promise.all([import('@/components/Providers'), pagina()]);
  await act(async () => {
    root = createRoot(contenedor);
    root.render(<Providers><Pagina /></Providers>);
  });
  await avanzar(5_000);            // carga inicial (sesión, proveedor, pantalla)
  const tras5s = foto();
  await avanzar(5 * 60_000);       // abierta 5 minutos: 5 recargas de 60 s
  return { tras5s, tras5min: foto() };
}

// La recarga de 60 s del proveedor (reloadAll) vuelve a pedir estas, a propósito.
const RECARGA_PERIODICA = new Set([
  'teachers', 'teacher_calendars', 'students', 'assignments', 'scoring_events',
  'rpc/get_students_with_assignments', 'rpc/get_unassigned_students',
]);

function sinBucles(tras5s: Record<string, number>, tras5min: Record<string, number>) {
  expect(document.hidden, 'jsdom tiene que estar "visible" para que corra la recarga de 60 s').toBe(false);
  // La recarga de 60 s sí corrió (si no, el test no probaría nada de ella).
  expect((tras5min.teachers ?? 0) - (tras5s.teachers ?? 0)).toBeGreaterThanOrEqual(5);
  for (const [tabla, n] of Object.entries(tras5min)) {
    // Ningún bucle: con 5 recargas, ninguna tabla llega a 20 peticiones.
    expect(n, `${tabla}: ${n} peticiones en 5 min`).toBeLessThan(20);
    if (RECARGA_PERIODICA.has(tabla) || tabla.startsWith('/api/')) continue;
    // Lo que no es de la recarga se pide al abrir y NUNCA más.
    expect(n, `${tabla} se volvió a pedir con la pantalla abierta (${tras5s[tabla] ?? 0} → ${n})`).toBe(tras5s[tabla] ?? 0);
  }
}

describe('pantallas abiertas 5 minutos: ninguna carga en bucle', () => {
  it('ficha del alumno (/mis-alumnos/[id])', async () => {
    const { tras5s, tras5min } = await abrirCincoMinutos(() => import('@/app/mis-alumnos/[studentId]/page'), '/mis-alumnos/s1', { studentId: 's1' });
    sinBucles(tras5s, tras5min);
    expect(tras5min.class_join_logs, 'ingresos: la carga del proveedor y la de la ficha').toBeLessThanOrEqual(2);
    expect(tras5min.student_profiles ?? 0).toBeGreaterThanOrEqual(1);   // la ficha sí cargó
    expect(tras5min.calendar_changes ?? 0, 'la ficha no usa el historial').toBe(0);
  });

  it('/asistencias', async () => {
    const { tras5s, tras5min } = await abrirCincoMinutos(() => import('@/app/asistencias/page'), '/asistencias');
    sinBucles(tras5s, tras5min);
    expect(tras5min.class_join_logs).toBeLessThanOrEqual(2);
    expect(tras5min.calendar_changes, 'el historial: una vez, al abrir').toBe(1);
  });

  it('/clases', async () => {
    const { tras5s, tras5min } = await abrirCincoMinutos(() => import('@/app/clases/page'), '/clases');
    sinBucles(tras5s, tras5min);
    expect(tras5min.class_join_logs, 'loadFinanceData del proveedor y la de /clases').toBeLessThanOrEqual(2);
    expect(tras5min.calendar_changes ?? 0, '/clases no usa el historial').toBe(0);
    expect(tras5min.form_tokens ?? 0, '/clases sí cargó (su índice de formularios)').toBeGreaterThanOrEqual(1);
  });
});
