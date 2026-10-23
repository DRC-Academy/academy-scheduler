import { describe, expect, it } from 'vitest';
import { buildRegisterPdf, pdfSafe, MAX_PDF_BYTES } from '@/lib/classRegisterPdf';
import type { RegisterRow } from '@/lib/classRegister';

const row = (i: number): RegisterRow => ({
  id: `r${i}`, date: '2026-10-20', hour: '18:00', hoursLabel: '18:00 - 20:00', durationHours: 2,
  studentName: i % 7 === 0 ? 'María José Nombre Muy Largo de Prueba Con Varios Apellidos Para Partir Línea' : `Alumno ${i}`,
  teacherId: 't1', teacherName: 'Sebastian (test)', status: i % 3 === 0 ? 'reprogramada' : 'realizada',
  joinedAt: '2026-10-20T15:58:00Z', ip: '203.0.113.7', hasTranscript: i % 2 === 0, rescheduledTo: i % 3 === 0 ? '2026-10-23' : null,
});

describe('PDF del registro', () => {
  it('es un PDF, pagina y no lleva ningún enlace', async () => {
    const buf = await buildRegisterPdf({
      rows: Array.from({ length: 400 }, (_, i) => row(i)), desde: '2026-10-01', hasta: '2026-10-22',
      alumno: { name: 'Ana Pérez', email: 'ana@example.com', teachers: ['Sebastian (test)'] },
      nowMs: Date.UTC(2026, 9, 22, 10),
    });
    const raw = buf.toString('latin1');
    expect(raw.startsWith('%PDF-')).toBe(true);
    expect(raw).not.toMatch(/\/URI|\/Link|\/Annots/);
    expect((raw.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(5);
    expect(buf.length).toBeLessThan(MAX_PDF_BYTES);
  });
  it('sin filas, una página con el aviso', async () => {
    const buf = await buildRegisterPdf({ rows: [], desde: '2026-10-01', hasta: '2026-10-22', alumno: null });
    expect((buf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBe(1);
  });
  it('pdfSafe: deja Latin-1 y quita lo que Helvetica no tiene', () => {
    expect(pdfSafe('Pérez Ñoño — «hola» €')).toBe('Pérez Ñoño — «hola» €');
    expect(pdfSafe('Łukasz Wójcik')).toBe('Lukasz Wójcik');
  });
});
