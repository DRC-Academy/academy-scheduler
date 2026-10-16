import { describe, expect, it } from 'vitest';
import {
  calcularScoringV2, confianzaDe, construirExposicion, intervencionSuavizada, nivelDe, puntosHabla, puntosPorTasa, tasaSuavizada,
  type AsignacionScore, type BajaScore, type EntradaScore,
} from '@/lib/teacherScore';
import type { ClassJoinLog } from '@/types';

const HOY = '2026-10-16';
const NOW = Date.parse('2026-10-16T12:00:00Z');

const asig = (p: Partial<AsignacionScore> & { teacherId: string; studentName: string }): AsignacionScore => ({
  id: `a-${p.teacherId}-${p.studentName}`, studentId: null, status: 'active', teacherSince: '2026-01-01',
  startDate: null, createdAt: '2026-01-01T10:00:00Z', calendarRemovedAt: null, ...p,
});
const baja = (p: Partial<BajaScore> & { teacherId: string; studentName: string; droppedAt: string }): BajaScore => ({
  id: `b-${Math.random()}`, studentId: null, startDate: '2026-05-01', ...p,
});
const ingreso = (teacherId: string, studentName: string, date: string, punctuality = 'on_time'): ClassJoinLog => ({
  id: `j-${teacherId}-${studentName}-${date}`, teacherId, teacherName: teacherId, studentName,
  scheduledDate: date, scheduledTime: '10:00', clickedAt: `${date}T08:00:00Z`, punctuality, source: 'click',
} as unknown as ClassJoinLog);

function entrada(p: Partial<EntradaScore> = {}): EntradaScore {
  return {
    hoy: HOY, now: NOW,
    profesores: [{ id: 'A', name: 'Ana', createdAt: '2026-06-03T00:00:00Z', weeklyLoad: 10, freeSpots: 10 }],
    asignaciones: [], bajas: [], transferencias: [], ingresos: [], records: [], transcripts: [],
    primeraSubida: new Map(), recuperaciones: [], eventos: [], auditorias: [], analisis: [],
    habla: new Map(), primeraClase: new Map(), ...p,
  };
}

describe('retención: puntos por tasa', () => {
  it('0 bajas = 100, igual al promedio = 60, el doble o más = 0, lineal entre medio', () => {
    expect(puntosPorTasa(0, 0.2)).toBe(100);
    expect(puntosPorTasa(0.2, 0.2)).toBe(60);
    expect(puntosPorTasa(0.4, 0.2)).toBe(0);
    expect(puntosPorTasa(0.8, 0.2)).toBe(0);
    expect(puntosPorTasa(0.1, 0.2)).toBeCloseTo(80);
    expect(puntosPorTasa(0.3, 0.2)).toBeCloseTo(30);
  });

  it('el suavizado tira hacia el promedio con poca exposición', () => {
    expect(tasaSuavizada(0, 0, 0.2)).toBeCloseTo(0.2);          // sin exposición: el promedio
    expect(tasaSuavizada(0, 6, 0.2)).toBeCloseTo(0.1);          // K = 6: mitad y mitad
    expect(tasaSuavizada(0, 600, 0.2)).toBeLessThan(0.003);     // mucha exposición: su propia tasa
  });
});

describe('exposición y bajas', () => {
  it('deduplica las bajas por profe y alumno (primera fecha) y cuenta las descartadas', () => {
    const exp = construirExposicion({
      hoy: HOY, transferencias: [], asignaciones: [],
      bajas: [
        baja({ teacherId: 'A', studentName: 'Virginia Alfonso', droppedAt: '2026-08-10T10:00:00Z' }),
        baja({ teacherId: 'A', studentName: 'virginia  alfonso', droppedAt: '2026-08-01T10:00:00Z' }),
        baja({ teacherId: 'A', studentName: 'Virgínia Alfonso', droppedAt: '2026-08-20T10:00:00Z' }),
        baja({ teacherId: 'B', studentName: 'Virginia Alfonso', droppedAt: '2026-08-05T10:00:00Z' }),
      ],
    });
    expect(exp.bajasPorProfe.get('A')).toEqual([{ studentName: 'virginia  alfonso', fecha: '2026-08-01' }]);
    expect(exp.bajasPorProfe.get('B')).toHaveLength(1);
    expect([...exp.duplicados.values()].reduce((s, d) => s + d.descartadas, 0)).toBe(2);
  });

  it('inicio futuro e inactiva sin fecha de salida no suman; la baja sin asignación sí', () => {
    const exp = construirExposicion({
      hoy: HOY, transferencias: [],
      asignaciones: [
        asig({ teacherId: 'A', studentName: 'Futuro', teacherSince: '2026-11-02' }),
        asig({ teacherId: 'A', studentName: 'Inactiva', status: 'inactive' }),
        asig({ teacherId: 'A', studentName: 'Activa', teacherSince: '2026-10-01' }),
      ],
      bajas: [baja({ teacherId: 'A', studentName: 'Se fue', startDate: '2026-09-01', droppedAt: '2026-09-30T10:00:00Z' })],
    });
    const tramos = exp.tramos.map(t => `${t.studentName}:${t.desde}>${t.hasta}`).sort();
    expect(tramos).toEqual(['Activa:2026-10-01>2026-10-16', 'Se fue:2026-09-01>2026-09-30']);
  });

  it('el profe anterior a un cambio de profe suma su tramo hasta el cambio', () => {
    const exp = construirExposicion({
      hoy: HOY, bajas: [],
      asignaciones: [asig({ id: 'x', teacherId: 'B', studentName: 'Ana', teacherSince: '2026-10-13', startDate: '2026-07-01' })],
      transferencias: [{ assignmentId: 'x', fromTeacherId: 'A', createdAt: '2026-10-13T09:00:00Z' }],
    });
    expect(exp.tramos.find(t => t.teacherId === 'A')).toMatchObject({ desde: '2026-07-01', hasta: '2026-10-13' });
  });
});

describe('puntaje total', () => {
  it('los pilares sin datos quedan en null y su peso se reparte', () => {
    const r = calcularScoringV2(entrada({
      asignaciones: [asig({ teacherId: 'A', studentName: 'Uno' }), asig({ teacherId: 'B', studentName: 'Dos' })],
      bajas: [baja({ teacherId: 'B', studentName: 'Tres', droppedAt: '2026-09-01T10:00:00Z' })],
    }));
    const a = r.profesores[0];
    expect(a.pilares.riesgo.score).toBeNull();
    expect(a.pilares.calidad.score).toBeNull();
    expect(a.pilares.retencion.score).not.toBeNull();
    // Solo la retención tiene dato: pesa el 100% y el total es su puntaje.
    expect(a.pilares.retencion.pesoEfectivo).toBe(100);
    expect(a.score).toBe(a.pilares.retencion.score);
  });

  it('queja −10 cada una; felicitación (bonus_feedback) +5 con máximo una por ventana; los revertidos no cuentan', () => {
    const ev = (eventType: string, d: string, reverted = false) =>
      ({ id: `${eventType}${d}`, teacherId: 'A', eventType, createdAt: `${d}T10:00:00Z`, reverted });
    const r = calcularScoringV2(entrada({
      asignaciones: [asig({ teacherId: 'A', studentName: 'Uno' })],
      eventos: [
        ev('queja', '2026-09-01'), ev('queja', '2026-09-02', true),
        ev('bonus_feedback', '2026-09-03'), ev('bonus_feedback', '2026-09-04'),
        ev('falta_injustificada', '2026-09-05'),            // evento viejo: el v2 lo ignora
        ev('queja', '2026-06-01'),                         // fuera de la ventana
      ],
    }));
    expect(r.profesores[0].ajustes.total).toBe(-5);
    expect(r.profesores[0].score).toBe(r.profesores[0].scorePilares! - 5);
  });

  it('sin ningún dato: puntaje null y "En evaluación"', () => {
    const r = calcularScoringV2(entrada());
    expect(r.profesores[0].score).toBeNull();
    expect(r.profesores[0].level).toBe('En evaluación');
  });

  it('la puntualidad toma un ingreso por clase y no cuenta los manuales del admin', () => {
    const ingresos = [
      ...['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'].map(d => ingreso('A', 'Uno', d)),
      ingreso('A', 'Uno', '2026-09-05', 'late'),
      { ...ingreso('A', 'Uno', '2026-09-06', 'very_late'), source: 'manual' } as ClassJoinLog,
    ];
    const r = calcularScoringV2(entrada({ asignaciones: [asig({ teacherId: 'A', studentName: 'Uno' })], ingresos }));
    const p = r.profesores[0].pilares.cumplimiento.partes!.puntualidad;
    expect(p.numeros).toMatchObject({ clases: 5, aTiempo: 4, tarde: 1, muyTarde: 0 });
    expect(p.score).toBe(90);
  });

  it('riesgo: el % de intervención se suaviza hacia el de la academia con K_RIESGO = 5', () => {
    expect(intervencionSuavizada(3, 3, 0.8)).toBeCloseTo(7 / 8);      // 3 de 3 con academia 80% → 87,5%
    expect(intervencionSuavizada(0, 0, 0.8)).toBeCloseTo(0.8);        // sin auditorías: el promedio
    const aud = (teacherId: string, i: number, si: boolean) =>
      ({ id: `${teacherId}${i}`, teacherId, studentName: 'X', signsOfIntervention: si, createdAt: '2026-09-10T10:00:00Z' });
    const r = calcularScoringV2(entrada({
      profesores: [
        { id: 'A', name: 'Ana', createdAt: '2026-06-03T00:00:00Z', weeklyLoad: 0, freeSpots: 0 },
        { id: 'B', name: 'Bea', createdAt: '2026-06-03T00:00:00Z', weeklyLoad: 0, freeSpots: 0 },
      ],
      // A: 3 de 3. B: 1 de 5. Academia: 4 de 8 = 50%.
      auditorias: [
        ...[0, 1, 2].map(i => aud('A', i, true)),
        aud('B', 0, true), ...[1, 2, 3, 4].map(i => aud('B', i, false)),
      ],
    }));
    const [a, b] = r.profesores;
    expect(a.pilares.riesgo.score).toBe(68.8);   // (3 + 5·0,5) / (3 + 5) = 68,75 %
    expect(b.pilares.riesgo.score).toBe(35);     // (1 + 5·0,5) / (5 + 5) = 35 %
  });

  it('el profe veterano cuenta desde su alta aunque la primera clase registrada sea reciente', () => {
    const r = calcularScoringV2(entrada({ primeraClase: new Map([['A', '2026-08-01']]) }));
    expect(r.profesores[0].experiencia.primeraClase).toBe('2026-06-03');
  });
});

describe('confianza, nivel y habla', () => {
  it('confianza según exposición y clases', () => {
    expect(confianzaDe(12, 30)).toBe('alta');
    expect(confianzaDe(12, 29)).toBe('media');
    expect(confianzaDe(4, 0)).toBe('media');
    expect(confianzaDe(3.9, 100)).toBe('baja');
  });

  it('niveles: En evaluación manda sobre el puntaje; luego los umbrales 85 / 75 / 60', () => {
    expect(nivelDe(95, 'baja', 200).level).toBe('En evaluación');
    expect(nivelDe(95, 'alta', 60).level).toBe('En evaluación');
    expect(nivelDe(85, 'alta', 100).level).toBe('Top');
    expect(nivelDe(84.9, 'alta', 100).level).toBe('Destacado');
    expect(nivelDe(75, 'alta', 100).level).toBe('Destacado');
    expect(nivelDe(74.9, 'alta', 100).level).toBe('Estándar');
    expect(nivelDe(60, 'alta', 100).level).toBe('Estándar');
    expect(nivelDe(59.9, 'alta', 100).level).toBe('En revisión');
  });

  it('Top solo con confianza alta: con confianza media un puntaje de Top queda en Destacado', () => {
    expect(nivelDe(95, 'media', 200).level).toBe('Destacado');
    expect(nivelDe(95, 'alta', 200).level).toBe('Top');
  });

  it('habla: igual a la mediana = 60, +15 pp = 100, −22,5 pp = 0', () => {
    expect(puntosHabla(42, 42)).toBe(60);
    expect(puntosHabla(57, 42)).toBe(100);
    expect(puntosHabla(19.5, 42)).toBe(0);
    expect(puntosHabla(49.5, 42)).toBeCloseTo(80);
  });
});
