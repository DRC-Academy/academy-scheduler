import { describe, it, expect } from 'vitest';
import { summarizeByTeacher, sortUsage, type AiGenerationRow } from './aiUsage';

const teachers = [
  { id: 'p1', name: 'Seba' },
  { id: 'p2', name: 'Mauri' },
  { id: 'p3', name: 'Johny' },
  { id: 't1', name: 'Sebastian (test)' },   // cuenta de prueba
];

let n = 0;
const gen = (o: Partial<AiGenerationRow>): AiGenerationRow => ({
  id: `g${++n}`,
  teacher_id: null,
  teacher_name: null,
  student_id: null,
  student_name: 'Alumno',
  origin: 'directa',
  created_at: '2026-09-01T10:00:00.000Z',
  ...o,
});

describe('summarizeByTeacher — quién usa y quién no', () => {
  it('incluye a los profesores con CERO: son los que la pestaña quiere enseñar', () => {
    const r = summarizeByTeacher([gen({ teacher_id: 'p1' })], teachers);
    const nombres = r.perTeacher.map(t => t.teacherName);
    expect(nombres).toContain('Mauri');
    expect(nombres).toContain('Johny');
    expect(r.perTeacher.find(t => t.teacherId === 'p2')!.total).toBe(0);
    expect(r.perTeacher.find(t => t.teacherId === 'p2')!.lastUsed).toBeNull();
  });

  it('el contador "X de Y" cuenta solo a los que la han usado', () => {
    const r = summarizeByTeacher([gen({ teacher_id: 'p1' }), gen({ teacher_id: 'p1' })], teachers);
    expect(r.usan).toBe(1);
    expect(r.totalProfesores).toBe(4);
  });

  // El fallo real de sep/2026: la primera generación registrada fue de `t1`
  // ("Sebastian (test)"). Al excluirlo, su fila no cruzaba con nadie, caía en el
  // saco de los huérfanos y el panel decía "0 de 28" con un uso real delante.
  it('una cuenta de prueba que SÍ ha generado cuenta como que usa la herramienta', () => {
    const r = summarizeByTeacher([gen({ teacher_id: 't1', teacher_name: 'Sebastian (test)' })], teachers);
    const seba = r.perTeacher.find(t => t.teacherId === 't1')!;
    expect(seba.total).toBe(1);
    expect(seba.known).toBe(true);          // está en la plantilla: no es huérfana
    expect(r.usan).toBe(1);
  });

  it('quien entra en el denominador lo decide quien llama, no esta función', () => {
    const r = summarizeByTeacher([], teachers);
    expect(r.totalProfesores).toBe(teachers.length);
    expect(r.perTeacher.some(t => t.teacherId === 't1')).toBe(true);
  });

  it('cruza por id y, si la fila no lo trae, por nombre', () => {
    const r = summarizeByTeacher([
      gen({ teacher_id: 'p1', teacher_name: 'Seba' }),
      gen({ teacher_id: null, teacher_name: '  seba  ' }),   // solo nombre, con espacios y minúsculas
    ], teachers);
    expect(r.perTeacher.find(t => t.teacherId === 'p1')!.total).toBe(2);
    expect(r.usan).toBe(1);
  });

  it('separa las que vienen de pegar transcripción', () => {
    const r = summarizeByTeacher([
      gen({ teacher_id: 'p1', origin: 'transcript' }),
      gen({ teacher_id: 'p1', origin: 'transcript' }),
      gen({ teacher_id: 'p1', origin: 'directa' }),
    ], teachers);
    const p1 = r.perTeacher.find(t => t.teacherId === 'p1')!;
    expect(p1.total).toBe(3);
    expect(p1.fromTranscript).toBe(2);
  });

  it('la última vez es la MÁS RECIENTE, aunque las filas lleguen desordenadas', () => {
    const r = summarizeByTeacher([
      gen({ teacher_id: 'p1', created_at: '2026-08-01T10:00:00.000Z' }),
      gen({ teacher_id: 'p1', created_at: '2026-09-05T10:00:00.000Z' }),
      gen({ teacher_id: 'p1', created_at: '2026-07-01T10:00:00.000Z' }),
    ], teachers);
    expect(r.perTeacher.find(t => t.teacherId === 'p1')!.lastUsed).toBe('2026-09-05T10:00:00.000Z');
  });

  it('un profesor que ya no está en la plantilla no se descarta: sale marcado', () => {
    // Si se tirara la fila, el total del resumen no cuadraría con el listado
    // detallado y parecería que faltan generaciones.
    const r = summarizeByTeacher([gen({ teacher_id: 'zz', teacher_name: 'Sofia' })], teachers);
    const sofia = r.perTeacher.find(t => t.teacherName === 'Sofia')!;
    expect(sofia.total).toBe(1);
    expect(sofia.known).toBe(false);
    // Y no cuenta en el "X de Y", que habla de la plantilla actual.
    expect(r.usan).toBe(0);
    expect(r.totalProfesores).toBe(4);
  });

  it('agrupa varias filas huérfanas del mismo nombre en una sola', () => {
    const r = summarizeByTeacher([
      gen({ teacher_id: 'zz', teacher_name: 'Sofia' }),
      gen({ teacher_id: 'zz', teacher_name: 'Sofia' }),
    ], teachers);
    expect(r.perTeacher.filter(t => t.teacherName === 'Sofia')).toHaveLength(1);
    expect(r.perTeacher.find(t => t.teacherName === 'Sofia')!.total).toBe(2);
  });

  it('sin registro, todos a cero y nadie usándola', () => {
    const r = summarizeByTeacher([], teachers);
    expect(r.usan).toBe(0);
    expect(r.perTeacher.every(t => t.total === 0)).toBe(true);
  });
});

describe('sortUsage', () => {
  const base = summarizeByTeacher([
    gen({ teacher_id: 'p1', created_at: '2026-09-06T10:00:00.000Z' }),
    gen({ teacher_id: 'p1', created_at: '2026-09-05T10:00:00.000Z' }),
    gen({ teacher_id: 'p3', created_at: '2026-06-01T10:00:00.000Z' }),
  ], teachers).perTeacher;

  it('"sin-usar" pone delante a quien nunca la usó, y detrás del más frío al más reciente', () => {
    expect(sortUsage(base, 'sin-usar').map(t => t.teacherName))
      .toEqual(['Mauri', 'Sebastian (test)', 'Johny', 'Seba']);
  });

  it('"mas-activos" ordena por volumen', () => {
    expect(sortUsage(base, 'mas-activos').map(t => t.teacherName))
      .toEqual(['Seba', 'Johny', 'Mauri', 'Sebastian (test)']);
  });

  it('no muta la lista original', () => {
    const antes = base.map(t => t.teacherName);
    sortUsage(base, 'mas-activos');
    expect(base.map(t => t.teacherName)).toEqual(antes);
  });
});
