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
import { crearRefrescoHistorial, cargarSinEsperarHistorial } from '@/lib/slotHistory';

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

  it('ARREGLO: la carga termina igual y el historial se corta a los 8 s sin guardar nada', async () => {
    vi.useFakeTimers();
    const guardar = vi.fn();
    let signal: AbortSignal | undefined;
    const refrescar = crearRefrescoHistorial({ leer: (_s, sig) => { signal = sig; return nuncaResponde(); }, guardar });

    const carga = cargarSinEsperarHistorial(refrescar, ingresos);
    expect(await estado(carga)).toBe('resuelta');
    expect(await carga).toEqual(['log1']);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(signal?.aborted).toBe(true);    // la petición se corta: no se deja trabajando a la base
    expect(guardar).not.toHaveBeenCalled(); // sin historial: cada vista proyecta el horario de hoy
  });

  it('tras un fallo se reintenta en la siguiente carga; si va bien, no se repite hasta 10 minutos después', async () => {
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
