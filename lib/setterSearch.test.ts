import { describe, expect, it } from 'vitest';
import { activeSelection, matchTeacher, pickRecommended, searchTeachers, DEFAULT_STATUSES, type SetterQuery } from '@/lib/setterSearch';
import type { Teacher } from '@/types';

const prof = (o: Partial<Teacher>): Teacher => ({
  id: 'x', name: 'X', email: 'x@x.com', avatar: 'X', status: 'available', weeklyLoad: 0, maxWeeklyLoad: 20,
  freeSpots: 5, totalSpots: 5, specialties: ['Inglés'], libreCells: [], ...o,
}) as Teacher;

const q = (o: Partial<SetterQuery> = {}): SetterQuery => ({
  mode: 'dayhour', days: [], hours: [], coverage: 'all', name: '', specialties: [], statuses: [...DEFAULT_STATUSES], ...o,
});

const ana  = prof({ id: 'a', name: 'Ana',  freeSpots: 3, libreCells: ['Lunes_18:00', 'Martes_18:00', 'Lunes_19:00'] });
const bea  = prof({ id: 'b', name: 'Bea',  freeSpots: 9, libreCells: ['Lunes_18:00', 'Martes_18:00', 'Lunes_19:00', 'Martes_19:00'], specialties: ['Inglés', 'Adultos', 'Exámenes'] });
const ciro = prof({ id: 'c', name: 'Ciro', freeSpots: 0, status: 'busy', libreCells: [] });
const dani = prof({ id: 'd', name: 'Dani', freeSpots: 2, status: 'almost_full', libreCells: ['Sábado_10:00', 'Domingo_18:00'], specialties: ['Inglés', 'Adultos'] });

describe('activeSelection', () => {
  it('Día + hora con solo días o solo horas se comporta como Solo día / Solo hora', () => {
    expect(activeSelection({ mode: 'dayhour', days: ['Martes', 'Lunes'], hours: [] })).toEqual({ mode: 'day', days: ['Lunes', 'Martes'], hours: [] });
    expect(activeSelection({ mode: 'dayhour', days: [], hours: ['19:00', '07:00'] })).toEqual({ mode: 'hour', days: [], hours: ['07:00', '19:00'] });
  });
  it('el bloque atenuado no cuenta', () => {
    expect(activeSelection({ mode: 'day', days: ['Lunes'], hours: ['18:00'] }).mode).toBe('day');
    expect(activeSelection({ mode: 'hour', days: ['Lunes'], hours: [] }).mode).toBe('none');
  });
});

describe('matchTeacher', () => {
  it('Día + hora: producto cruzado día × hora', () => {
    const m = matchTeacher(ana, q({ days: ['Lunes', 'Martes'], hours: ['18:00', '19:00'] }));
    expect(m.total).toBe(4);
    expect(m.matched).toBe(3);
    expect(m.franjas.map(f => `${f.label}:${f.free}`)).toEqual(['Lun 18:00:true', 'Lun 19:00:true', 'Mar 18:00:true', 'Mar 19:00:false']);
  });
  it('Solo día: cuenta el día con al menos una hora libre', () => {
    const m = matchTeacher(ana, q({ mode: 'day', days: ['Lunes', 'Miércoles'] }));
    expect([m.matched, m.total]).toEqual([1, 2]);
    expect(m.freeCells).toEqual([{ day: 'Lunes', hour: '18:00' }, { day: 'Lunes', hour: '19:00' }]);
  });
  it('Solo hora: cualquier día de Lun a Sáb, nunca las celdas viejas de domingo', () => {
    expect(matchTeacher(dani, q({ mode: 'hour', hours: ['18:00'] })).matched).toBe(0);
    expect(matchTeacher(dani, q({ mode: 'hour', hours: ['10:00'] })).matched).toBe(1);
  });
});

describe('searchTeachers', () => {
  it('sin días ni horas: todos los que pasan estado / especialidad / nombre', () => {
    expect(searchTeachers([ana, bea, ciro, dani], q(), 'name').map(m => m.teacher.name)).toEqual(['Ana', 'Bea', 'Dani']);
  });
  it('Todas las franjas vs Alguna franja', () => {
    const sel = { days: ['Lunes', 'Martes'], hours: ['18:00', '19:00'] };
    expect(searchTeachers([ana, bea, dani], q({ ...sel, coverage: 'all' }), 'suggested').map(m => m.teacher.name)).toEqual(['Bea']);
    expect(searchTeachers([ana, bea, dani], q({ ...sel, coverage: 'any' }), 'suggested').map(m => m.teacher.name)).toEqual(['Bea', 'Ana']);
  });
  it('especialidades: hay que tenerlas todas', () => {
    expect(searchTeachers([ana, bea, dani], q({ specialties: ['Adultos', 'Exámenes'] }), 'name').map(m => m.teacher.name)).toEqual(['Bea']);
  });
  it('Sugerido: franjas, luego estado, luego cupos', () => {
    const e = prof({ id: 'e', name: 'Eva', freeSpots: 20, status: 'almost_full', libreCells: ['Lunes_18:00'] });
    const f = prof({ id: 'f', name: 'Fer', freeSpots: 1, libreCells: ['Lunes_18:00'] });
    const rows = searchTeachers([e, f, ana], q({ days: ['Lunes'], hours: ['18:00'] }), 'suggested');
    expect(rows.map(m => m.teacher.name)).toEqual(['Ana', 'Fer', 'Eva']);
  });
});

describe('pickRecommended', () => {
  it('salta Completo, bloqueados y sin cupos', () => {
    const blocked = prof({ id: 'z', name: 'Zoe', isBlocked: true });
    const rows = searchTeachers([ciro, blocked, dani], q({ statuses: ['available', 'almost_full', 'busy'] }), 'name');
    expect(pickRecommended(rows)?.teacher.name).toBe('Dani');
  });
});
