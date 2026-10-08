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
