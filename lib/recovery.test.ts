// Las cuatro reglas de la recuperación, con los casos REALES de agosto de 2026
// que las motivaron. Cada test lleva el caso que lo trajo, para que quien lo
// cambie sepa qué se rompió la última vez.
import { describe, it, expect } from 'vitest';
import { checkRecovery, existingRecoveriesOf } from '@/lib/recovery';
import type { ClassJoinLog, ClassRecord, ClassRecordType } from '@/types';

const rec = (name: string, date: string, classType: ClassRecordType, recoveryForDate?: string): ClassRecord => ({
  id: `r_${name}_${date}_${classType}`, teacherId: 't1', teacherName: 'Prof', studentName: name,
  classDate: date, classTime: '17:00', screenshotUrl: '', classType, recoveryForDate,
  createdAt: `${date}T20:00:00Z`,
});
const log = (name: string, date: string): ClassJoinLog => ({
  id: `l_${name}_${date}`, teacherId: 't1', teacherName: 'Prof', studentName: name,
  scheduledDate: date, scheduledTime: '17:00', clickedAt: `${date}T17:00:00Z`, punctuality: 'on_time',
});
const check = (o: Partial<Parameters<typeof checkRecovery>[0]> = {}) => checkRecovery({
  studentName: 'Ana', recoveryDate: '2026-08-20', lostDate: '2026-08-11',
  classRecords: [], joinLogs: [], existing: [], ...o,
});

describe('no se recupera lo que todavía no se perdió', () => {
  it('fecha posterior — Daiana · Lucia Granado, clase del 06/08 saldando el 12/08', () => {
    const v = check({ recoveryDate: '2026-08-06', lostDate: '2026-08-12' });
    expect(v.ok).toBe(false);
    expect(v.kind).toBe('futura');
    expect(v.title).toContain('todavía no se dio');
  });

  it('el MISMO día — Silvia · Paula Tatiana, clase del 04/08 saldando el 04/08', () => {
    const v = check({ recoveryDate: '2026-08-04', lostDate: '2026-08-04' });
    expect(v.kind).toBe('futura');
    expect(v.title).toContain('esta misma clase');
  });

  it('año de cinco cifras — Dana · Mar Oliva, "82026-05-03"', () => {
    expect(check({ lostDate: '82026-05-03' }).kind).toBe('formato');
    expect(check({ lostDate: '' }).kind).toBe('formato');
  });
});

describe('quién tiene derecho', () => {
  it('falta CON aviso: sí', () => {
    expect(check({ classRecords: [rec('Ana', '2026-08-11', 'falta_con_aviso')] }).ok).toBe(true);
  });

  it('cancelación con preaviso, reprogramada y cancelada por el profesor: sí', () => {
    for (const t of ['cancelada_con_preaviso', 'reprogramada', 'cancelada_por_profesor'] as ClassRecordType[]) {
      expect(check({ classRecords: [rec('Ana', '2026-08-11', t)] }).ok, t).toBe(true);
    }
  });

  it('falta SIN aviso: no — se le cobró, la clase se perdió', () => {
    const v = check({ classRecords: [rec('Ana', '2026-08-11', 'falta_sin_aviso')] });
    expect(v.kind).toBe('sin_derecho');
    expect(v.detail).toContain('faltó sin avisar');
  });

  it('cancelación sobre la hora: no — si no, saldría ganando por cancelar tarde', () => {
    // Silvia · Paula Tatiana: dos recuperaciones sobre una cancelación a la hora.
    const v = check({ classRecords: [rec('Ana', '2026-08-11', 'cancelacion_hora')] });
    expect(v.kind).toBe('sin_derecho');
    expect(v.detail).toContain('canceló sobre la hora');
  });

  it('con derecho Y sin derecho el mismo día: manda el que no da derecho', () => {
    const v = check({ classRecords: [
      rec('Ana', '2026-08-11', 'falta_con_aviso'),
      rec('Ana', '2026-08-11', 'falta_sin_aviso'),
    ] });
    expect(v.kind).toBe('sin_derecho');
  });
});

describe('no hay nada que recuperar', () => {
  it('ese día se dio clase — DanielaN · Mercedez Morilla, recuperando una recuperación', () => {
    const v = check({ classRecords: [rec('Ana', '2026-08-11', 'recuperacion')] });
    expect(v.kind).toBe('clase_dada');
  });

  it('sin registro pero con ingreso: también es clase dada', () => {
    const v = check({ joinLogs: [log('Ana', '2026-08-11')] });
    expect(v.kind).toBe('clase_dada');
  });
});

describe('una clase perdida se recupera UNA vez', () => {
  it('Silvia · Paula Tatiana: el 18 y el 20 de agosto apuntando ambos al 11', () => {
    const v = check({
      recoveryDate: '2026-08-20',
      classRecords: [rec('Ana', '2026-08-11', 'falta_con_aviso')],
      existing: [{ studentName: 'Ana', date: '2026-08-18', recoveryFor: '2026-08-11' }],
    });
    expect(v.kind).toBe('ya_recuperada');
    expect(v.detail).toContain('18/08/2026');
  });

  it('editar la MISMA recuperación no cuenta como duplicado', () => {
    const v = check({
      recoveryDate: '2026-08-20',
      classRecords: [rec('Ana', '2026-08-11', 'falta_con_aviso')],
      existing: [{ studentName: 'Ana', date: '2026-08-20', recoveryFor: '2026-08-11' }],
    });
    expect(v.ok).toBe(true);
  });

  it('la de otro alumno no bloquea', () => {
    const v = check({
      classRecords: [rec('Ana', '2026-08-11', 'falta_con_aviso')],
      existing: [{ studentName: 'Beto', date: '2026-08-18', recoveryFor: '2026-08-11' }],
    });
    expect(v.ok).toBe(true);
  });
});

describe('la salida cuando no consta nada', () => {
  it('ofrece registrar la falta con aviso — el caso de 54 de las 187 de agosto', () => {
    const v = check();
    expect(v.kind).toBe('sin_registro');
    expect(v.offerRegister).toBe(true);
    expect(v.detail).toContain('registralo ahora');
  });

  it('registrada la falta, la misma comprobación pasa', () => {
    expect(check({ classRecords: [rec('Ana', '2026-08-11', 'falta_con_aviso')] }).ok).toBe(true);
  });

  it('una fecha ya saldada NO ofrece registrar nada', () => {
    const v = check({ existing: [{ studentName: 'Ana', date: '2026-08-18', recoveryFor: '2026-08-11' }] });
    expect(v.kind).toBe('ya_recuperada');
    expect(v.offerRegister).toBeUndefined();
  });
});

describe('las recuperaciones que ya existen salen de las DOS vías', () => {
  it('celdas del calendario y class_records, con el nombre normalizado', () => {
    const out = existingRecoveriesOf({
      studentName: '  ana  ',
      classRecords: [
        rec('Ana', '2026-08-20', 'recuperacion', '2026-08-11'),
        rec('Ana', '2026-08-21', 'normal'),          // sin recoveryForDate: fuera
        rec('Beto', '2026-08-20', 'recuperacion', '2026-08-11'),  // otro alumno: fuera
      ],
      recoveryCells: [
        { studentName: 'ANA', date: '2026-08-18', recoveryFor: '2026-08-11' },
        { studentName: 'Ana', date: '2026-08-19' },  // celda sin fecha: fuera
      ],
    });
    expect(out.map(r => r.date).sort()).toEqual(['2026-08-18', '2026-08-20']);
  });
});
