// Las pantallas cargan las pausas con dbGetStudentPauses. En producción la tabla
// student_pauses todavía no existe (SQL sin correr): tienen que funcionar igual
// (sin pausas) y sin volver a pedirla en cada carga.
import { describe, it, expect, vi } from 'vitest';

const { lecturas } = vi.hoisted(() => ({ lecturas: { n: 0 } }));
vi.mock('@/lib/supabase', async () => {
  const { FakeDb } = await import('@/lib/transferencia/fakeDb.test-helper');
  const db = new FakeDb({});
  db.hooks.failRead = (t: string) => (t === 'student_pauses'
    ? (lecturas.n++, { message: "Could not find the table 'public.student_pauses' in the schema cache", code: 'PGRST205' })
    : null);
  return { supabase: db.client() };
});

import { dbGetStudentPauses, esTablaAusente } from '@/lib/studentPauses';

describe('pausas sin la tabla student_pauses', () => {
  it('devuelve [] (nadie en pausa), sin lanzar, y no la vuelve a pedir', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(dbGetStudentPauses()).resolves.toEqual([]);
    await expect(dbGetStudentPauses()).resolves.toEqual([]);
    await expect(dbGetStudentPauses()).resolves.toEqual([]);
    expect(lecturas.n).toBe(1);
    info.mockRestore();
  });

  it('reconoce los dos códigos de "tabla ausente"', () => {
    expect(esTablaAusente({ code: 'PGRST205' })).toBe(true);
    expect(esTablaAusente({ code: '42P01' })).toBe(true);
    expect(esTablaAusente({ code: '42501' })).toBe(false);
    expect(esTablaAusente(null)).toBe(false);
  });
});
