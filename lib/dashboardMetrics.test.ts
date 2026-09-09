import { describe, it, expect } from 'vitest';
import {
  weekRange, monthKey, previousMonth, madridDateString, diasEntre,
  esClaseDada, operacionDelMes, clasesEnRango, clasesProgramadasSemana,
  transcriptsPendientes, ocupacionDe, tonoOcupacion, filasProfesores,
  faltasProfesorDelMes, alumnosResumen,
} from './dashboardMetrics';
import type { ClassRecord, ClassJoinLog, ScoringEvent, Teacher, Assignment } from '@/types';

const rec = (o: Partial<ClassRecord>): ClassRecord => ({
  id: Math.random().toString(36).slice(2),
  teacherId: 'p1', teacherName: 'Seba',
  studentName: 'Ana', classDate: '2026-09-10',
  screenshotUrl: '', createdAt: '2026-09-10T10:00:00Z',
  ...o,
});

describe('ventanas de tiempo', () => {
  it('la semana va de lunes a domingo', () => {
    // 2026-09-10 es jueves.
    const r = weekRange(new Date('2026-09-10T12:00:00Z'));
    expect(r.from).toBe('2026-09-07');   // lunes
    expect(r.to).toBe('2026-09-13');     // domingo
  });

  it('el lunes ya es el primer día de su propia semana, no el último de la anterior', () => {
    const r = weekRange(new Date('2026-09-07T09:00:00Z'));
    expect(r.from).toBe('2026-09-07');
  });

  it('el domingo cierra su semana, no abre la siguiente', () => {
    const r = weekRange(new Date('2026-09-13T12:00:00Z'));
    expect(r.from).toBe('2026-09-07');
    expect(r.to).toBe('2026-09-13');
  });

  it('el domingo a las 23 h de Madrid ya es la semana siguiente', () => {
    // 21:30 UTC del domingo = 23:30 en Madrid: sigue siendo domingo.
    expect(weekRange(new Date('2026-09-13T21:30:00Z')).from).toBe('2026-09-07');
    // 22:30 UTC = 00:30 del lunes en Madrid: semana nueva.
    expect(weekRange(new Date('2026-09-13T22:30:00Z')).from).toBe('2026-09-14');
  });

  it('el mes anterior cruza el cambio de año', () => {
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(previousMonth('2026-09')).toBe('2026-08');
  });

  it('la fecha sale en horario de Madrid', () => {
    // 23:30 UTC del 9 ya es el día 10 en Madrid (verano, UTC+2).
    expect(madridDateString(new Date('2026-09-09T23:30:00Z'))).toBe('2026-09-10');
  });

  it('monthKey usa la misma fecha de Madrid', () => {
    expect(monthKey(new Date('2026-08-31T23:30:00Z'))).toBe('2026-09');
  });

  it('diasEntre cuenta días completos', () => {
    expect(diasEntre('2026-09-08', '2026-09-10')).toBe(2);
    expect(diasEntre('2026-09-10', '2026-09-10')).toBe(0);
  });
});

describe('qué cuenta como clase dada', () => {
  it('normal y recuperación sí; el resto no', () => {
    expect(esClaseDada({ classType: 'normal' })).toBe(true);
    expect(esClaseDada({ classType: undefined })).toBe(true);      // el defecto es normal
    expect(esClaseDada({ classType: 'recuperacion' })).toBe(true);
    for (const t of ['falta_sin_aviso', 'cancelacion_hora', 'reprogramada',
      'falta_con_aviso', 'cancelada_con_preaviso', 'cancelada_por_profesor'] as const) {
      expect(esClaseDada({ classType: t })).toBe(false);
    }
  });
});

describe('operacionDelMes', () => {
  const records: ClassRecord[] = [
    rec({ classDate: '2026-09-01' }),
    rec({ classDate: '2026-09-02', classType: 'normal' }),
    rec({ classDate: '2026-09-03', classType: 'falta_sin_aviso' }),           // cobrada: no recuperable
    rec({ classDate: '2026-09-04', classType: 'falta_sin_aviso_revertida' }), // marca, no clase
    rec({ classDate: '2026-09-05', classType: 'cancelacion_hora' }),          // cobrada: no recuperable
    rec({ classDate: '2026-09-06', classType: 'reprogramada' }),              // recuperable, se salda
    rec({ classDate: '2026-09-07', classType: 'cancelada_por_profesor' }),    // recuperable, pendiente
    rec({ classDate: '2026-09-20', classType: 'recuperacion', recoveryForDate: '2026-09-06' }),
    rec({ classDate: '2026-08-15' }),   // otro mes
  ];
  const r = operacionDelMes(records, '2026-09');

  it('cuenta las dadas incluyendo las recuperaciones', () => expect(r.dadas).toBe(3));
  it('la falta revertida no cuenta como falta', () => expect(r.faltasSinAviso).toBe(1));
  it('todo lo que no se dio cuenta como no dada, salvo la marca de revertida', () => expect(r.noDadas).toBe(4));
  it('cuenta las recuperaciones del mes', () => expect(r.recuperaciones).toBe(1));

  it('una perdida que ya tiene recuperación deja de estar pendiente', () => {
    // La del 06 la salda la recuperación del 20; queda pendiente la del 07.
    expect(r.recuperacionesPendientes).toBe(1);
  });

  // El fallo que encontraron estos tests: contaba como "pendiente de recuperar"
  // una falta sin aviso, que es justo la que NO da derecho a nada.
  it('una falta sin aviso NO está pendiente de recuperar: se le cobró al alumno', () => {
    const soloFalta = operacionDelMes([rec({ classDate: '2026-09-03', classType: 'falta_sin_aviso' })], '2026-09');
    expect(soloFalta.noDadas).toBe(1);
    expect(soloFalta.recuperacionesPendientes).toBe(0);
  });

  it('una cancelación sobre la hora tampoco', () => {
    const soloCancel = operacionDelMes([rec({ classDate: '2026-09-05', classType: 'cancelacion_hora' })], '2026-09');
    expect(soloCancel.recuperacionesPendientes).toBe(0);
  });

  it('la recuperación salda aunque llegue en otro mes', () => {
    const sinRecuperar = operacionDelMes(records.filter(x => x.classType !== 'recuperacion'), '2026-09');
    expect(sinRecuperar.recuperacionesPendientes).toBe(2);
  });

  it('ignora los meses que no son', () => {
    expect(operacionDelMes(records, '2026-08').dadas).toBe(1);
  });
});

describe('clasesEnRango', () => {
  it('los dos extremos entran', () => {
    const records = [
      rec({ classDate: '2026-09-07' }),
      rec({ classDate: '2026-09-13' }),
      rec({ classDate: '2026-09-14' }),   // fuera
      rec({ classDate: '2026-09-06' }),   // fuera
    ];
    expect(clasesEnRango(records, { from: '2026-09-07', to: '2026-09-13' })).toBe(2);
  });

  it('no cuenta las que no se dieron', () => {
    const records = [rec({ classDate: '2026-09-08', classType: 'falta_sin_aviso' })];
    expect(clasesEnRango(records, { from: '2026-09-07', to: '2026-09-13' })).toBe(0);
  });
});

describe('clasesProgramadasSemana', () => {
  it('suma los horarios de todas las asignaciones', () => {
    const as = [
      { slots: [{ day: 'Lunes', hour: '10:00' }, { day: 'Jueves', hour: '10:00' }] },
      { slots: [{ day: 'Martes', hour: '18:00' }] },
      { slots: [] },
      {},
    ] as unknown as Assignment[];
    expect(clasesProgramadasSemana(as)).toBe(3);
  });
});

describe('transcriptsPendientes', () => {
  const log = (o: Partial<ClassJoinLog>): ClassJoinLog => ({
    id: Math.random().toString(36).slice(2),
    teacherId: 'p1', teacherName: 'Seba', studentName: 'Ana',
    scheduledDate: '2026-09-01', scheduledTime: '10:00',
    clickedAt: '2026-09-01T08:00:00Z', punctuality: 'on_time',
    ...o,
  });

  it('una clase con transcript no está pendiente', () => {
    const r = transcriptsPendientes(
      [log({})],
      [{ student_name: 'ANA', class_date: '2026-09-01', has_transcript: true }],
      { hoy: '2026-09-10' },
    );
    expect(r).toHaveLength(0);
  });

  // Los tres fallos que hacían que un profesor apareciera con 99 clases sin
  // subir cuando ninguna era de este mes.
  it('el vínculo explícito cubre el ingreso aunque la fecha no coincida', () => {
    // 1.148 de los 1.460 análisis reales traen join_log_id. Ignorarlo era el
    // fallo grande: bastaba que el profesor tecleara otra fecha en el análisis.
    const l = log({ id: 'jl-1' });
    const r = transcriptsPendientes(
      [l],
      [{ student_name: 'Ana', class_date: '2026-08-14', has_transcript: true, join_log_id: 'jl-1' }],
      { hoy: '2026-09-10' },
    );
    expect(r).toHaveLength(0);
  });

  it('un transcript a un día de distancia también cubre', () => {
    const r = transcriptsPendientes(
      [log({ scheduledDate: '2026-09-02' })],
      [{ student_name: 'Ana', class_date: '2026-09-01', has_transcript: true }],
      { hoy: '2026-09-10' },
    );
    expect(r).toHaveLength(0);
  });

  it('un transcript se CONSUME: no puede cubrir dos clases', () => {
    const r = transcriptsPendientes(
      [log({ id: 'a', scheduledDate: '2026-09-01' }), log({ id: 'b', scheduledDate: '2026-09-02' })],
      [{ student_name: 'Ana', class_date: '2026-09-01', has_transcript: true }],
      { hoy: '2026-09-10' },
    );
    expect(r).toHaveLength(1);
  });

  it('solo mira la ventana: los meses ya liquidados no arrastran', () => {
    const r = transcriptsPendientes(
      [log({ scheduledDate: '2026-07-15' }), log({ scheduledDate: '2026-08-20' }), log({ scheduledDate: '2026-09-02' })],
      [],
      { hoy: '2026-09-10' },
    );
    expect(r).toHaveLength(1);
    expect(r[0].fecha).toBe('2026-09-02');
  });

  it('la ventana se puede ampliar a mano', () => {
    const r = transcriptsPendientes(
      [log({ scheduledDate: '2026-07-15' }), log({ scheduledDate: '2026-09-02' })],
      [],
      { hoy: '2026-09-10', desde: '2026-07-01' },
    );
    expect(r).toHaveLength(2);
  });

  it('un ingreso del futuro no cuenta', () => {
    const r = transcriptsPendientes([log({ scheduledDate: '2026-09-30' })], [], { hoy: '2026-09-10' });
    expect(r).toHaveLength(0);
  });

  it('cruza el alumno sin distinguir mayúsculas ni espacios', () => {
    const r = transcriptsPendientes(
      [log({ studentName: '  ana  ' })],
      [{ student_name: 'Ana', class_date: '2026-09-01', has_transcript: true }],
      { hoy: '2026-09-10' },
    );
    expect(r).toHaveLength(0);
  });

  it('una fila de análisis SIN transcript no tapa el pendiente', () => {
    const r = transcriptsPendientes(
      [log({})],
      [{ student_name: 'Ana', class_date: '2026-09-01', has_transcript: false }],
      { hoy: '2026-09-10' },
    );
    expect(r).toHaveLength(1);
  });

  it('respeta el margen: la clase de ayer todavía está en plazo', () => {
    const ayer = transcriptsPendientes([log({ scheduledDate: '2026-09-10' })], [], { hoy: '2026-09-10' });
    expect(ayer).toHaveLength(0);
    const anteayer = transcriptsPendientes([log({ scheduledDate: '2026-09-08' })], [], { hoy: '2026-09-10' });
    expect(anteayer).toHaveLength(1);
    expect(anteayer[0].dias).toBe(2);
  });

  // 509 ingresos duplicados en la base real, 93 de ellos en un solo mes: el botón
  // "Ingresar a clase" se pulsa dos veces y se registran dos.
  it('dos ingresos de la misma clase cuentan una vez', () => {
    const r = transcriptsPendientes([log({ id: 'a' }), log({ id: 'b' })], [], { hoy: '2026-09-10' });
    expect(r).toHaveLength(1);
  });

  it('basta con que UNO de los ingresos duplicados tenga el transcript vinculado', () => {
    const r = transcriptsPendientes(
      [log({ id: 'a' }), log({ id: 'b' })],
      [{ student_name: 'Ana', class_date: '2026-09-01', has_transcript: true, join_log_id: 'b' }],
      { hoy: '2026-09-10' },
    );
    expect(r).toHaveLength(0);
  });

  it('el mismo alumno con dos profesores el mismo día son dos clases', () => {
    const r = transcriptsPendientes(
      [log({ id: 'a', teacherId: 'p1' }), log({ id: 'b', teacherId: 'p2' })],
      [], { hoy: '2026-09-10' },
    );
    expect(r).toHaveLength(2);
  });

  it('ordena del más viejo al más reciente', () => {
    const r = transcriptsPendientes([
      log({ scheduledDate: '2026-09-08', studentName: 'Ana' }),
      log({ scheduledDate: '2026-09-01', studentName: 'Bea' }),
    ], [], { hoy: '2026-09-10' });
    expect(r.map(x => x.studentName)).toEqual(['Bea', 'Ana']);
  });
});

describe('ocupacionDe', () => {
  const t = (totalSpots: number, freeSpots: number) => ({ totalSpots, freeSpots }) as Teacher;

  it('el profesor sin calendario abierto no hunde el porcentaje', () => {
    expect(ocupacionDe([t(10, 2), t(0, 0)])).toEqual({ ocupados: 8, total: 10, pct: 80 });
  });

  it('sin nadie con calendario devuelve 0 y no divide por cero', () => {
    expect(ocupacionDe([t(0, 0)])).toEqual({ ocupados: 0, total: 0, pct: 0 });
  });

  it('el semáforo respeta los umbrales declarados', () => {
    expect(tonoOcupacion(80)).toBe('ok');
    expect(tonoOcupacion(75)).toBe('ok');
    expect(tonoOcupacion(74)).toBe('aviso');
    expect(tonoOcupacion(60)).toBe('aviso');
    expect(tonoOcupacion(59)).toBe('alerta');
  });
});

describe('filasProfesores', () => {
  const teachers = [
    { id: 'p1', name: 'Seba', freeSpots: 2 },
    { id: 'p2', name: 'Mauri', freeSpots: 0 },
    { id: 'p3', name: 'Johny', freeSpots: 5 },
  ] as Teacher[];

  const filas = filasProfesores({
    teachers,
    records: [
      rec({ teacherId: 'p1', classDate: '2026-09-01' }),
      rec({ teacherId: 'p1', classDate: '2026-09-02' }),
      rec({ teacherId: 'p2', classDate: '2026-09-03' }),
      rec({ teacherId: 'p1', classDate: '2026-08-01' }),                       // otro mes
      rec({ teacherId: 'p1', classDate: '2026-09-04', classType: 'reprogramada' }), // no dada
    ],
    mes: '2026-09',
    pendientes: [
      { teacherId: 'p2', teacherName: 'Mauri', studentName: 'Ana', fecha: '2026-09-01', dias: 4 },
    ],
    teacherIdsConIA: new Set(['p1']),
  });

  it('ordena por clases del mes, de más a menos', () => {
    expect(filas.map(f => f.teacherName)).toEqual(['Seba', 'Mauri', 'Johny']);
  });

  it('incluye a quien no dio ninguna clase', () => {
    expect(filas.find(f => f.teacherId === 'p3')!.clases).toBe(0);
  });

  it('solo cuenta las clases dadas de ese mes', () => {
    expect(filas.find(f => f.teacherId === 'p1')!.clases).toBe(2);
  });

  it('lleva cupos, pendientes y uso de IA de cada uno', () => {
    const mauri = filas.find(f => f.teacherId === 'p2')!;
    expect(mauri.transcriptsPendientes).toBe(1);
    expect(mauri.usaIA).toBe(false);
    expect(filas.find(f => f.teacherId === 'p1')!.usaIA).toBe(true);
    expect(filas.find(f => f.teacherId === 'p3')!.cuposLibres).toBe(5);
  });
});

describe('faltasProfesorDelMes', () => {
  const ev = (o: Partial<ScoringEvent>): ScoringEvent => ({
    id: Math.random().toString(36).slice(2),
    teacherId: 'p1', teacherName: 'Seba',
    eventType: 'falta_sin_aviso_penalizacion', points: 0, euros: -5,
    note: '', createdAt: '2026-09-05T10:00:00Z', createdBy: 'admin',
    ...o,
  });

  it('cuenta las del mes y descarta las revertidas y las de otro tipo', () => {
    const eventos = [
      ev({}),
      ev({ reverted: true }),
      ev({ createdAt: '2026-08-05T10:00:00Z' }),
      ev({ eventType: 'upsell' }),
    ];
    expect(faltasProfesorDelMes(eventos, '2026-09')).toBe(1);
  });
});

describe('alumnosResumen', () => {
  it('cruza por id y, si no, por nombre', () => {
    const students = [{ id: 's1', name: 'Ana' }, { id: 's2', name: 'Bea' }, { id: 's3', name: 'Cris' }];
    const assignments = [
      { studentId: 's1', studentName: 'Ana' },
      { studentId: '', studentName: '  bea  ' },   // sin id: cruza por nombre
    ] as unknown as Assignment[];
    const r = alumnosResumen(students, assignments);
    expect(r.total).toBe(3);
    expect(r.conClase).toBe(2);
    expect(r.sinProfesor).toBe(1);   // Cris
  });
});
