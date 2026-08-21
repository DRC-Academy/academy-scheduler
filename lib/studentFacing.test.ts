import { describe, it, expect } from 'vitest';
import { isForStudent, keepForStudent, forStudentOrNull } from './studentFacing';

// Textos REALES sacados de la base el 21/08/2026 (alumno con la ficha a medias).
// Son los que llegaron a verse en la página pública antes del cortafuegos.
const NOTAS_INTERNAS = [
  "No especificado: el alumno respondió '1' a la pregunta sobre su motivación. Conviene preguntárselo directamente al inicio de la primera clase.",
  "No se puede determinar con precisión porque no respondió a qué se le resiste del inglés (respondió '1')",
  'Falta información clave sobre su ocupación, objetivos y frustraciones previas',
  'Dado que la ficha está incompleta, la prioridad de las primeras clases es doble: (1) completar el diagnóstico real (ocupación, objetivo, dificultades) mediante conversación, y (2) activar la producción oral.',
];

// Textos de ficha que sí son para el alumno y NO se pueden perder por el camino.
const PUBLICABLES = [
  'Según su autoevaluación, la comprensión oral es su punto más fuerte, valorado como bueno',
  'Muestra buena disposición: dispone de más de 4 horas semanales para dedicar al inglés fuera de clase',
  'No usa el inglés fuera de clase, por lo que la producción real en contexto está sin trabajar',
  'Conseguir un puesto en una multinacional y dejar de bloquearse en las reuniones',
  'Trabajamos la fluidez en pasado y los conectores para que las frases largas no se te rompan',
  'Quiere viajar a Irlanda el año que viene y moverse sin depender del traductor',
];

describe('isForStudent', () => {
  it('corta las notas escritas para el profesor', () => {
    for (const t of NOTAS_INTERNAS) {
      expect(isForStudent(t), `debería cortarse: ${t.slice(0, 60)}…`).toBe(false);
    }
  });

  it('deja pasar lo que sí es para el alumno', () => {
    for (const t of PUBLICABLES) {
      expect(isForStudent(t), `no debería cortarse: ${t.slice(0, 60)}…`).toBe(true);
    }
  });

  it('detecta las marcas aunque vengan sin tildes o en mayúsculas', () => {
    expect(isForStudent('EL ALUMNO no completó el formulario')).toBe(false);
    expect(isForStudent('no se puede determinar el nivel')).toBe(false);
    expect(isForStudent('Falta informacion sobre su trabajo')).toBe(false);
  });

  it('el texto vacío no es publicable', () => {
    expect(isForStudent('')).toBe(false);
    expect(isForStudent('   ')).toBe(false);
    expect(isForStudent(null)).toBe(false);
    expect(isForStudent(undefined)).toBe(false);
  });
});

describe('keepForStudent', () => {
  it('filtra la lista y conserva el orden', () => {
    const salida = keepForStudent([PUBLICABLES[0], NOTAS_INTERNAS[1], PUBLICABLES[1]]);
    expect(salida).toEqual([PUBLICABLES[0], PUBLICABLES[1]]);
  });

  it('devuelve lista vacía si todo era interno (la tarjeta no se pinta)', () => {
    expect(keepForStudent(NOTAS_INTERNAS)).toEqual([]);
  });
});

describe('forStudentOrNull', () => {
  it('devuelve el texto limpio o null', () => {
    expect(forStudentOrNull('  Quiere aprobar el B2  ')).toBe('Quiere aprobar el B2');
    expect(forStudentOrNull(NOTAS_INTERNAS[0])).toBeNull();
    expect(forStudentOrNull(null)).toBeNull();
  });
});
