import { describe, expect, it } from 'vitest';
import { buildPenaltyRows, summarizePenalties, type PenaltyAbsence, type PenaltyRecovery } from '@/lib/penaltiesView';
import { calculateTeacherFinance } from '@/lib/finance';
import type { ScoringEvent } from '@/types';

const ev = (o: Partial<ScoringEvent>): ScoringEvent => ({
  id: 'e', teacherId: 't3', teacherName: 'Johny', eventType: 'falta_profesor_penalizacion', points: 0, euros: -10,
  note: '', createdAt: '2026-10-23T16:31:00Z', createdBy: 'sistema', ...o,
});
const AUS = 'aus_t3_2026-10-23_18_alberto-gonzalez';
const abs = (o: Partial<PenaltyAbsence> = {}): PenaltyAbsence => ({
  id: AUS, teacherId: 't3', teacherName: 'Johny', studentName: 'Alberto Gonzalez',
  classDate: '2026-10-23', classHour: '18:00', status: 'posible_ausencia', penaltyState: 'cobrada', penaltyReason: null,
  detectedAt: '2026-10-23T16:30:00Z', ...o,
});
const rec = (o: Partial<PenaltyRecovery> = {}): PenaltyRecovery => ({
  groupId: 'grp_a', teacherId: 't3', studentName: 'Ana', originalDate: '2026-10-26', originalHour: '17:00',
  cancelledAt: '2026-10-25T10:00:00Z', late: true, status: 'esperando_alumno', origin: 'profesor', penaltyEventId: null, ...o,
});
const nombre = (id: string) => ({ t3: 'Johny', t24: 'Liliana' } as Record<string, string>)[id] ?? id;

describe('filas', () => {
  it('falta detectada: alumno, clase y origen salen de la posible ausencia', () => {
    const rows = buildPenaltyRows({
      events: [ev({ id: `se_falta_prof_${AUS}`, note: 'Falta del profesor (no se conectó a la clase) — alumno Alberto Gonzalez, fecha 2026-10-23 18:00', appliesMonth: '2026-10' })],
      recoveries: [], absences: [abs()], teacherName: nombre,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'falta', studentName: 'Alberto Gonzalez', classDate: '2026-10-23', classHour: '18:00', euros: 10, state: 'cobrada', origin: 'deteccion', month: '2026-10', absenceId: AUS });
  });

  it('falta reclasificada sin ficha de ausencia: los datos salen de la nota', () => {
    const rows = buildPenaltyRows({
      events: [ev({ id: 'se_falta_prof_aus_t3_2026-10-24_10_ana', note: 'Falta del profesor (reclasificada por el admin desde una revisión) — alumno Ana, fecha 2026-10-24 10:00', appliesMonth: '2026-10' })],
      recoveries: [], absences: [], teacherName: nombre,
    });
    expect(rows[0]).toMatchObject({ studentName: 'Ana', classDate: '2026-10-24', classHour: '10:00', origin: 'reclasificacion' });
  });

  it('cancelación: alumno, clase y momento de la cancelación salen de la recuperación', () => {
    const rows = buildPenaltyRows({
      events: [ev({ id: 'se_cancel_prof_grp_a', eventType: 'cancelacion_profesor_penalizacion', euros: -5, appliesMonth: '2026-10' })],
      recoveries: [rec({ penaltyEventId: 'se_cancel_prof_grp_a' })], absences: [], teacherName: nombre,
    });
    expect(rows[0]).toMatchObject({ kind: 'cancelacion', studentName: 'Ana', classDate: '2026-10-26', classHour: '17:00', at: '2026-10-25T10:00:00Z', euros: 5, origin: 'cancelacion' });
  });

  it('revertida: quién y el motivo del compensatorio <multa>_rev', () => {
    const id = `se_falta_prof_${AUS}`;
    const rows = buildPenaltyRows({
      events: [
        ev({ id, reverted: true, revertedBy: 'Facundo', revertedAt: '2026-10-24T09:00:00Z', appliesMonth: '2026-10' }),
        ev({ id: `${id}_rev`, eventType: 'penalizacion_revertida', euros: 10, note: 'Reversión de la falta (Alberto). Motivo: fallo de Meet', createdAt: '2026-10-24T09:00:01Z' }),
      ],
      recoveries: [], absences: [abs()], teacherName: nombre,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'revertida', revertedBy: 'Facundo', revertReason: 'fallo de Meet' });
  });

  it('"sin cobrar: revisar" sale de la ausencia; desaparece si después se cobró', () => {
    const revisar = abs({ penaltyState: 'revisar', penaltyReason: 'Intentó cancelar con la app vieja' });
    const sinCobrar = buildPenaltyRows({ events: [], recoveries: [], absences: [revisar], teacherName: nombre });
    expect(sinCobrar[0]).toMatchObject({ state: 'revisar', eventId: null, euros: 10, month: '2026-10', chargeable: true });
    const cobrada = buildPenaltyRows({ events: [ev({ id: `se_falta_prof_${AUS}` })], recoveries: [], absences: [revisar], teacherName: nombre });
    expect(cobrada.map(r => r.state)).toEqual(['cobrada']);
  });

  it('antiguas: solo las que restaban dinero; los eventos de puntos no salen', () => {
    const rows = buildPenaltyRows({
      events: [
        ev({ id: 'se_old', teacherId: 't24', eventType: 'falta_sin_aviso_penalizacion', euros: -5, note: 'Cancelación sin antelación — alumno Gema Ávila Marín, fecha 2026-10-15', createdAt: '2026-10-15T17:53:00Z' }),
        ev({ id: 'se_pts', eventType: 'atraso', euros: 0 }),
      ],
      recoveries: [], absences: [], teacherName: nombre,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'antigua', studentName: 'Gema Ávila Marín', classDate: '2026-10-15', euros: 5, origin: 'antigua' });
  });
});

describe('resumen y cuadre con Finanzas', () => {
  const events = [
    ev({ id: `se_falta_prof_${AUS}`, appliesMonth: '2026-10' }),
    ev({ id: 'se_cancel_prof_grp_c', eventType: 'cancelacion_profesor_penalizacion', euros: -5, appliesMonth: '2026-10' }),
    ev({ id: 'se_falta_prof_x', reverted: true, appliesMonth: '2026-10' }),
    ev({ id: 'se_old', teacherId: 't24', eventType: 'falta_sin_aviso_penalizacion', euros: -5, createdAt: '2026-10-15T17:53:00Z' }),
  ];
  const recoveries = [rec({ groupId: 'grp_a' }), rec({ groupId: 'grp_b' }), rec({ groupId: 'grp_c', penaltyEventId: 'se_cancel_prof_grp_c' })];
  const rows = buildPenaltyRows({ events, recoveries, absences: [abs()], teacherName: nombre });

  it('cuenta faltas, cancelaciones con multa, comodines (máx. 2) y total', () => {
    const s = summarizePenalties({
      rows: rows.filter(r => r.kind !== 'antigua'), month: '2026-10', events, recoveries,
      teacherIds: new Set(['t3', 't24']), teacherName: nombre,
    });
    const johny = s.find(x => x.teacherId === 't3')!;
    expect(johny).toMatchObject({ faltas: 1, cancelaciones: 1, comodines: 2, total: 15, finanzas: 15, cuadra: true });
    // Liliana: sin multas nuevas, pero Finanzas le resta el −5 € viejo → no cuadra.
    const liliana = s.find(x => x.teacherId === 't24')!;
    expect(liliana).toMatchObject({ total: 0, finanzas: 5, cuadra: false });
  });

  it('con las antiguas, cuadra', () => {
    const s = summarizePenalties({ rows, month: '2026-10', events, recoveries, teacherIds: new Set(['t3', 't24']), teacherName: nombre });
    expect(s.find(x => x.teacherId === 't24')).toMatchObject({ total: 5, finanzas: 5, cuadra: true });
    expect(s[0].teacherId).toBe('t3');   // mayor importe primero
  });

  it('"Finanzas resta" es lo mismo que penaltiesFromScoring de calculateTeacherFinance', () => {
    const s = summarizePenalties({ rows, month: '2026-10', events, recoveries, teacherIds: new Set(['t3']), teacherName: nombre });
    const fin = calculateTeacherFinance({
      teacherId: 't3', teacherName: 'Johny', monthYear: '2026-10', assignments: [], joinLogs: [], classRecords: [],
      classAnalyses: [], rates: [], scoringEvents: events, students: [], manualApprovals: [], payment: null,
      teacherBonuses: [], gridOccupancy: {} as never,
    });
    expect(-fin.penaltiesFromScoring).toBe(s[0].finanzas);
  });
});
