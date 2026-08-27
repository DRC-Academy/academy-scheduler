import { describe, expect, it } from 'vitest';
import { effectiveLevelOf, getEffectiveLevel, referenceLevelOf, teacherReviewOf } from './effectiveLevel';

describe('getEffectiveLevel — prioridad', () => {
  it('el nivel del profesor manda sobre todos', () => {
    const r = getEffectiveLevel({
      teacherConfirmed: 'A2',
      fichaLevel:       'B2',
      testLevel:        'C1',
      assignmentLevel:  'B1',
    });
    expect(r.level).toBe('A2');
    expect(r.origin).toBe('profesor');
  });

  it('sin profesor manda la ficha, luego la prueba, luego el alta', () => {
    expect(getEffectiveLevel({ fichaLevel: 'B2', testLevel: 'C1', assignmentLevel: 'B1' }).origin).toBe('ficha');
    expect(getEffectiveLevel({ testLevel: 'C1', assignmentLevel: 'B1' }).origin).toBe('prueba');
    expect(getEffectiveLevel({ assignmentLevel: 'B1' }).origin).toBe('alta');
  });

  it('sin ninguna fuente devuelve todo en null', () => {
    expect(getEffectiveLevel({})).toEqual({
      level: null, raw: null, origin: null, correctedByTeacher: false,
    });
  });
});

describe('getEffectiveLevel — texto libre', () => {
  it('normaliza el CEFR pero conserva el texto original en raw', () => {
    const r = getEffectiveLevel({ assignmentLevel: 'Nivel B1 Exámenes' });
    expect(r.level).toBe('B1');
    expect(r.raw).toBe('Nivel B1 Exámenes');
  });

  it('una fuente rellena SIN CEFR dentro no tapa a la siguiente', () => {
    // El caso real: assignments.student_level dice "Inglés general" en producción.
    const r = getEffectiveLevel({ fichaLevel: 'Inglés general', testLevel: 'C1' });
    expect(r.level).toBe('C1');
    expect(r.origin).toBe('prueba');
  });

  it('si NADA parsea, devuelve el primer texto no vacío con level null', () => {
    const r = getEffectiveLevel({ fichaLevel: 'Inglés general', assignmentLevel: 'intermedio' });
    expect(r.level).toBeNull();
    expect(r.raw).toBe('Inglés general');
    expect(r.origin).toBe('ficha');
  });

  it('ignora los vacíos y los que son solo espacios', () => {
    const r = getEffectiveLevel({ teacherConfirmed: '   ', testLevel: 'B2' });
    expect(r.level).toBe('B2');
    expect(r.origin).toBe('prueba');
  });

  it('acepta el nivel del profesor en minúsculas', () => {
    expect(getEffectiveLevel({ teacherConfirmed: 'c1' }).level).toBe('C1');
  });
});

describe('correctedByTeacher', () => {
  it('true solo si el profesor corrigió Y difiere de la prueba', () => {
    expect(getEffectiveLevel({ teacherConfirmed: 'A2', testLevel: 'C1' }).correctedByTeacher).toBe(true);
    expect(getEffectiveLevel({ teacherConfirmed: 'C1', testLevel: 'C1' }).correctedByTeacher).toBe(false);
    expect(getEffectiveLevel({ teacherConfirmed: 'A2' }).correctedByTeacher).toBe(false);
    expect(getEffectiveLevel({ testLevel: 'C1' }).correctedByTeacher).toBe(false);
  });
});

describe('effectiveLevelOf / referenceLevelOf', () => {
  const ficha = {
    teacher_confirmed_level: 'A2',
    current_level: null,
    level_test_cefr: 'C1',
  };

  it('effectiveLevelOf lee la ficha tal como viene de Supabase', () => {
    expect(effectiveLevelOf(ficha, 'B1').level).toBe('A2');
  });

  it('sin ficha cae al nivel del alta', () => {
    expect(effectiveLevelOf(null, 'B1').level).toBe('B1');
    expect(effectiveLevelOf(undefined, null).level).toBeNull();
  });

  it('referenceLevelOf IGNORA al profesor: es lo que había antes de que opinara', () => {
    // Sin esto, el control le mostraría al profesor su propia respuesta como si
    // fuera el dato de partida contra el que decidir.
    const ref = referenceLevelOf(ficha, 'B1');
    expect(ref.level).toBe('C1');
    expect(ref.origin).toBe('prueba');
  });

  it('referenceLevelOf cae al alta cuando el alumno nunca hizo la prueba', () => {
    const ref = referenceLevelOf({ teacher_confirmed_level: 'B2' }, 'A2');
    expect(ref.level).toBe('A2');
    expect(ref.origin).toBe('alta');
  });
});

// ── Los tres estados de la revisión del profesor ─────────────────────────────
//
// El campo vacío decía dos cosas a la vez ("estoy de acuerdo" y "ni lo miré") y
// por eso el set de calibración de agosto tenía 2 pares y los dos eran
// correcciones. Estos tests fijan que los tres casos quedan separados.
describe('teacherReviewOf', () => {
  const ficha = (o: Record<string, string | null>) => ({
    level_test_cefr: null, teacher_confirmed_level: null,
    teacher_confirmed_at: null, teacher_confirmed_by: null, ...o,
  });

  it('sin pronunciarse → sin_revisar, y NO entra en la calibración', () => {
    const r = teacherReviewOf(ficha({ level_test_cefr: 'B2' }), null);
    expect(r.state).toBe('sin_revisar');
    expect(r.level).toBeNull();
    expect(r.comparable).toBe(false);
  });

  it('mismo nivel que la prueba → confirmado, y SÍ entra', () => {
    const r = teacherReviewOf(ficha({ level_test_cefr: 'B2', teacher_confirmed_level: 'B2' }), null);
    expect(r.state).toBe('confirmado');
    expect(r.comparable).toBe(true);
  });

  it('nivel distinto → corregido — Samantha Reyes, prueba B2 y la profesora puso A1', () => {
    const r = teacherReviewOf(ficha({ level_test_cefr: 'B2', teacher_confirmed_level: 'A1' }), null);
    expect(r.state).toBe('corregido');
    expect(r.against).toBe('B2');
    expect(r.comparable).toBe(true);
  });

  it('sin prueba: el profesor lo define, pero NO es un dato de calibración', () => {
    const r = teacherReviewOf(ficha({ teacher_confirmed_level: 'B1' }), 'Inglés general');
    expect(r.state).toBe('corregido');
    expect(r.comparable).toBe(false);
  });

  it('compara contra el nivel CONGELADO al confirmar, no contra el de hoy', () => {
    // Se confirmó un acuerdo con la prueba en B2; después se repitió y dio C1.
    // Sin el campo congelado, aquel acuerdo pasaría a leerse como corrección.
    const r = teacherReviewOf(ficha({
      level_test_cefr: 'C1', teacher_confirmed_level: 'B2', teacher_confirmed_against: 'B2',
    }), null);
    expect(r.state).toBe('confirmado');
    expect(r.against).toBe('B2');
  });

  it('sin el campo congelado cae al nivel de la prueba (la columna es opcional)', () => {
    const r = teacherReviewOf(ficha({ level_test_cefr: 'C1', teacher_confirmed_level: 'B2' }), null);
    expect(r.state).toBe('corregido');
    expect(r.against).toBe('C1');
  });

  it('el nivel del alta con texto suelto no cuenta como referencia comparable', () => {
    const r = teacherReviewOf(ficha({ teacher_confirmed_level: 'B1' }), 'B1 Exámenes');
    expect(r.state).toBe('confirmado');   // el alta sí parsea a B1
    expect(r.comparable).toBe(false);     // pero no es una prueba: no calibra nada
  });

  it('conserva quién y cuándo', () => {
    const r = teacherReviewOf(ficha({
      level_test_cefr: 'B2', teacher_confirmed_level: 'B1',
      teacher_confirmed_at: '2026-08-25T10:00:00Z', teacher_confirmed_by: 'Johny',
    }), null);
    expect(r.by).toBe('Johny');
    expect(r.at).toBe('2026-08-25T10:00:00Z');
  });
});
