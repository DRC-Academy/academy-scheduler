// La lista de "clases sin ingreso" del profesor. Es la que alimenta el envío en
// bloque, así que un falso positivo acá se convierte en una solicitud de pago
// sobre una clase que no corresponde.
import { describe, it, expect } from 'vitest';
import { buildMissingJoinClasses } from '@/lib/reviewRequests';
import { EMPTY_GRID_OCCUPANCY } from '@/lib/teacherClasses';
import type { Assignment, ClassJoinLog, ClassRecord } from '@/types';
import type { ClassTranscriptRef } from '@/lib/finance';

const T = 't1';
const HOY = '2026-08-26';
const NOW = 23 * 60;

const asgn: Assignment = {
  id: 'a1', teacherId: T, teacherName: 'Agustin', teacherEmail: 'a@x.com',
  studentId: 's1', studentName: 'Alma Garcia', studentEmail: 'alma@x.com',
  studentLevel: 'B1', slots: [{ day: 'Martes', hour: '15:00' }],
  objetivo: '', plan: 'Inglés general', weeklyHours: 1,
  availability: 'Martes 15:00', notes: '', startDate: '2026-01-01',
  createdAt: '2026-01-01T00:00:00Z',
};

// Martes de agosto de 2026: 4, 11, 18, 25.
const base = {
  assignments: [asgn], teacherId: T,
  fromDate: '2026-08-01', toDate: '2026-08-31',
  todayIso: HOY, nowMinutes: NOW,
  gridOccupancy: EMPTY_GRID_OCCUPANCY,
  requests: [],
};

const tx = (date: string, id: string): ClassTranscriptRef => ({
  id, teacher_id: T, student_name: 'Alma Garcia', class_date: date,
  has_transcript: true, validation_status: 'auto_approved',
});

const rec = (date: string, classType: ClassRecord['classType'] = 'normal'): ClassRecord => ({
  id: `cr_${date}`, teacherId: T, teacherName: 'Agustin', studentName: 'Alma Garcia',
  classDate: date, classTime: '15:00', screenshotUrl: '', classType,
  createdAt: `${date}T16:00:00Z`,
});

const log = (date: string): ClassJoinLog => ({
  id: `cjl_${date}`, teacherId: T, teacherName: 'Agustin', studentName: 'Alma Garcia',
  scheduledDate: date, scheduledTime: '15:00', clickedAt: `${date}T15:01:00Z`,
  punctuality: 'on_time',
});

describe('buildMissingJoinClasses', () => {
  it('sin rastro no lista nada (filtro por defecto)', () => {
    const out = buildMissingJoinClasses({ ...base, joinLogs: [], classRecords: [], analyses: [] });
    expect(out).toHaveLength(0);
  });

  it('el admin sí ve las que no tienen rastro', () => {
    const out = buildMissingJoinClasses({
      ...base, joinLogs: [], classRecords: [], analyses: [], onlyWithSignal: false,
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every(c => c.signal === null)).toBe(true);
  });

  it('lista la clase con transcript y le engancha el analysisId', () => {
    const out = buildMissingJoinClasses({
      ...base, joinLogs: [], classRecords: [], analyses: [tx('2026-08-11', 'ca_11')],
    });
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe('2026-08-11');
    expect(out[0].signal).toBe('transcript');
    expect(out[0].analysisId).toBe('ca_11');
  });

  it('un registro del profesor también es rastro, pero sin analysisId', () => {
    const out = buildMissingJoinClasses({
      ...base, joinLogs: [], classRecords: [rec('2026-08-11')], analyses: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0].signal).toBe('registro');
    expect(out[0].analysisId).toBeUndefined();
  });

  it('NO lista una clase que ya tiene ingreso ese día, aunque sea a otra hora', () => {
    // Es el caso que importa: finanzas empareja por alumno + FECHA, así que esa
    // clase ya está cobrada. Ofrecerla sería reclamar algo ya pagado.
    const otraHora: ClassJoinLog = { ...log('2026-08-11'), scheduledTime: '14:00' };
    const out = buildMissingJoinClasses({
      ...base, joinLogs: [otraHora], classRecords: [], analyses: [tx('2026-08-11', 'ca_11')],
    });
    expect(out).toHaveLength(0);
  });

  it('no lista clases anteriores al alta del alumno', () => {
    const tarde: Assignment = { ...asgn, startDate: '2026-08-15' };
    const out = buildMissingJoinClasses({
      ...base, assignments: [tarde], joinLogs: [], classRecords: [],
      analyses: [tx('2026-08-04', 'ca_04'), tx('2026-08-18', 'ca_18')],
    });
    expect(out.map(c => c.date)).toEqual(['2026-08-18']);
  });

  it('no lista las que ya tienen constancia de cancelación', () => {
    const out = buildMissingJoinClasses({
      ...base, joinLogs: [], classRecords: [rec('2026-08-11', 'falta_con_aviso')],
      analyses: [tx('2026-08-11', 'ca_11')],
    });
    expect(out).toHaveLength(0);
  });

  it('un transcript con un día de corrimiento sigue contando como rastro', () => {
    // El error caro es OCULTAR una clase reclamable; una fila de más no molesta.
    const out = buildMissingJoinClasses({
      ...base, joinLogs: [], classRecords: [], analyses: [tx('2026-08-12', 'ca_12')],
    });
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe('2026-08-11');
    expect(out[0].analysisId).toBe('ca_12');
  });

  it('ordena de la más reciente a la más vieja', () => {
    const out = buildMissingJoinClasses({
      ...base, joinLogs: [], classRecords: [],
      analyses: [tx('2026-08-04', 'a'), tx('2026-08-18', 'b'), tx('2026-08-11', 'c')],
    });
    expect(out.map(c => c.date)).toEqual(['2026-08-18', '2026-08-11', '2026-08-04']);
  });
});
