import { describe, it, expect, vi, afterEach } from 'vitest';
import { cargarSinBloquear } from '@/lib/slotHistory';

describe('cargarSinBloquear: el historial nunca cuelga ni rompe a quien lo pide', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('una carga que NUNCA termina devuelve null al agotar el tiempo', async () => {
    vi.useFakeTimers();
    const p = cargarSinBloquear(() => new Promise<never>(() => {}), 8_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(p).resolves.toBeNull();
  });

  it('una carga que falla devuelve null (y no lanza)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(cargarSinBloquear(() => Promise.reject(new Error('42501 permission denied')), 8_000)).resolves.toBeNull();
  });

  it('una carga normal devuelve su valor', async () => {
    await expect(cargarSinBloquear(async () => ({ t1: [] }), 8_000)).resolves.toEqual({ t1: [] });
  });
});

// ── El fallo del Paso 4 (producción, 08/10/2026) y su arreglo ─────────────────
import { crearRefrescoHistorial, profesoresConHistorial, asignacionesConHistorial } from '@/lib/slotHistory';
import type { SlotChange } from '@/types';

/** Estado de una promesa sin esperarla: 'pendiente' o 'resuelta'. */
async function estado(p: Promise<unknown>): Promise<'pendiente' | 'resuelta'> {
  let resuelta = false;
  void p.then(() => { resuelta = true; });
  // Deja correr las microtareas pendientes (una carga que no espera a nadie ya terminó).
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return resuelta ? 'resuelta' : 'pendiente';
}

describe('carga de /asistencias con el historial de horarios COLGADO', () => {
  afterEach(() => { vi.useRealTimers(); });
  const nuncaResponde = () => new Promise<never>(() => {});
  const ingresos = async () => ['log1'];

  it('REPRODUCE el fallo: el patrón de antes (Promise.all con el historial) no termina nunca', async () => {
    vi.useFakeTimers();
    // Lo que hacía loadClassJoinLogs antes del arreglo.
    const antes = Promise.all([ingresos(), nuncaResponde()]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await estado(antes)).toBe('pendiente');   // /asistencias se quedaba en el esqueleto
  });

  it('ARREGLO: el historial se pide aparte, nadie lo espera, y se corta a los 8 s sin guardar nada', async () => {
    vi.useFakeTimers();
    const guardar = vi.fn();
    let signal: AbortSignal | undefined;
    const pedir = crearRefrescoHistorial({ leer: (_s, sig) => { signal = sig; return nuncaResponde(); }, guardar });

    // pedir() no devuelve nada que esperar: las cargas de ingresos y finanzas ya
    // ni lo tocan (lib/HistorialHorariosContext lo pide aparte).
    expect(pedir()).toBeUndefined();
    const carga = ingresos();
    expect(await estado(carga)).toBe('resuelta');

    await vi.advanceTimersByTimeAsync(8_000);
    expect(signal?.aborted).toBe(true);    // la petición se corta: no se deja trabajando a la base
    expect(guardar).not.toHaveBeenCalled(); // sin historial: cada vista proyecta el horario de hoy
  });

  it('tras un fallo se reintenta en la siguiente petición; si va bien, no se repite hasta 10 minutos después', async () => {
    let ahora = 1_000_000;
    const leer = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('42501 permission denied')))
      .mockImplementation(async () => ({ t1: [] }));
    const guardar = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refrescar = crearRefrescoHistorial({ leer, guardar, ahora: () => ahora });

    refrescar(); await Promise.resolve(); await new Promise(r => setTimeout(r, 0));
    expect(guardar).not.toHaveBeenCalled();
    refrescar(); await new Promise(r => setTimeout(r, 0));        // reintento inmediato tras el fallo
    expect(guardar).toHaveBeenCalledWith({ t1: [] });
    refrescar(); await new Promise(r => setTimeout(r, 0));        // dentro de los 10 minutos: no repite
    expect(leer).toHaveBeenCalledTimes(2);
    ahora += 10 * 60_000;
    refrescar(); await new Promise(r => setTimeout(r, 0));
    expect(leer).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

// ── Aplicar el historial al pintar, sin cambiar identidades sin motivo ────────
describe('profesoresConHistorial / asignacionesConHistorial', () => {
  const cambio = { teacherId: 't1', studentName: 'Ana', day: 'Lunes', hour: '17:00', action: 'agregado' as const, createdAt: '2026-10-01T10:00:00Z' };

  it('sin historial devuelven el MISMO array (no relanzan efectos)', () => {
    const teachers = [{ id: 't1', name: 'Profe' }];
    const asgs = [{ teacherId: 't1', studentName: 'Ana' }];
    expect(profesoresConHistorial(teachers, {})).toBe(teachers);
    expect(asignacionesConHistorial(asgs, {})).toBe(asgs);
    // Con historial de OTRO profesor tampoco cambian.
    expect(profesoresConHistorial(teachers, { t2: [cambio] })).toBe(teachers);
    expect(asignacionesConHistorial(asgs, { t2: [cambio] })).toBe(asgs);
  });

  it('con historial: cada profesor y cada asignación llevan lo suyo', () => {
    const teachers: Array<{ id: string; name: string; slotChanges?: SlotChange[] }> = [{ id: 't1', name: 'Profe' }, { id: 't2', name: 'Otro' }];
    const out = profesoresConHistorial(teachers, { t1: [cambio] });
    expect(out[0].slotChanges).toEqual([cambio]);
    expect(out[1]).toBe(teachers[1]);
    const asgs: Array<{ teacherId: string; studentName: string; slotChanges?: SlotChange[] }> = [{ teacherId: 't1', studentName: 'ana' }, { teacherId: 't1', studentName: 'Beto' }];
    const a = asignacionesConHistorial(asgs, { t1: [cambio] });
    expect(a[0].slotChanges).toEqual([cambio]);
    expect(a[1]).toBe(asgs[1]);
  });
});
