// Datos de ejemplo de la Fase 2 (cambio de profesor), compartidos por los tests.
import { FakeDb } from '@/lib/transferencia/fakeDb.test-helper';

// Sábado 10/10/2026, 10:00 en España (UTC+2): el lunes queda a más de 24 h.
export const AHORA = Date.UTC(2026, 9, 10, 8, 0);
export const hace = (dias: number) => new Date(AHORA - dias * 86_400_000).toISOString();
const libres = (...claves: string[]) => Object.fromEntries(claves.map(k => [k, { state: 'libre' }]));

export function dbFase2() {
  return new FakeDb({
    teachers: [
      { id: 't1', name: 'Sebastian (test)', email: 't1@x.com', calendar_start_hour: 9, calendar_end_hour: 22 },
      { id: 'tA', name: 'Berta', email: 'berta@x.com', calendar_start_hour: 9, calendar_end_hour: 22 },
      { id: 'tB', name: 'Carla', email: 'carla@x.com', calendar_start_hour: 9, calendar_end_hour: 22 },
      { id: 'tC', name: 'Dani', email: 'dani@x.com', archived_at: '2026-09-01T00:00:00Z', calendar_start_hour: 9, calendar_end_hour: 22 },
      { id: 'tD', name: 'Eva', email: 'eva@x.com', calendar_start_hour: 9, calendar_end_hour: 22 },
      { id: 'tE', name: 'Fran', email: 'fran@x.com', calendar_start_hour: 9, calendar_end_hour: 22 },
    ],
    teacher_calendars: [
      { teacher_id: 't1', updated_at: hace(1), grid: libres('Lunes_10:00', 'Lunes_11:00') },
      { teacher_id: 'tA', updated_at: hace(2), grid: {
        'Martes_15:00': { state: 'ocupado', student: 'Lucía Pérez' },
        'Martes_16:00': { state: 'ocupado', student: 'Lucía Pérez' },
        'Jueves_10:00': { state: 'ocupado', student: 'Lucía Pérez' },
      } },
      { teacher_id: 'tB', updated_at: hace(3), grid: {
        ...libres('Lunes_10:00', 'Lunes_11:00', 'Miércoles_18:00', 'Martes_19:00', 'Martes_20:00'),
        'Lunes_12:00': { state: 'ocupado', student: 'Otro' },
      } },
      { teacher_id: 'tC', updated_at: hace(1), grid: libres('Lunes_10:00', 'Lunes_11:00') },
      { teacher_id: 'tD', updated_at: hace(40), grid: libres('Lunes_10:00', 'Lunes_11:00') },
      // updated_at viejo, pero lo tocó una persona hace poco: al día.
      { teacher_id: 'tE', updated_at: hace(45), grid: libres('Viernes_09:00', 'Viernes_10:00', 'Jueves_21:00') },
    ],
    calendar_changes: [
      { teacher_id: 'tE', origin: 'profesor', created_at: hace(5) },
      { teacher_id: 'tD', origin: 'sistema', created_at: hace(2) },   // el sistema no cuenta
    ],
    students: [{ id: 's1', name: 'Lucía Pérez', email: 'lucia@x.com', product_name: 'Ingles General - 3h semanales', company_plan_months: null, is_oritalk: false }],
    assignments: [
      { id: 'asg1', teacher_id: 'tA', teacher_name: 'Berta', teacher_email: 'berta@x.com', student_id: 's1', student_name: 'Lucía Pérez', student_email: 'lucia@x.com',
        status: 'active', weekly_hours: 3, plan: 'Ingles General - 3h semanales', start_date: '2026-09-01',
        slots: [{ day: 'Martes', hour: '15:00' }, { day: 'Martes', hour: '16:00' }, { day: 'Jueves', hour: '10:00' }] },
    ],
    class_recoveries: [], notifications: [], class_records: [], scoring_events: [], transfer_requests: [],
  });
}

