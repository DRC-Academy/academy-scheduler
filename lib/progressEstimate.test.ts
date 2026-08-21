import { describe, it, expect } from 'vitest';
import {
  GUIDED_HOURS_TO_REACH,
  PRACTICE_MULTIPLIER,
  WEEKS_PER_MONTH,
  MAX_WEEKLY_HOURS,
  hoursBetween,
  monthsFor,
  arrivalLabel,
  detectTargetLevel,
  buildEstimate,
} from './progressEstimate';

// Fecha fija: sin esto los tests de fecha de llegada fallarían solos cada mes.
const HOY = new Date(Date.UTC(2026, 7, 21));   // 21 de agosto de 2026

describe('tabla de horas guiadas', () => {
  it('es monótona creciente (A1 < A2 < … < C2)', () => {
    const niveles = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
    for (let i = 1; i < niveles.length; i++) {
      expect(GUIDED_HOURS_TO_REACH[niveles[i]]).toBeGreaterThan(GUIDED_HOURS_TO_REACH[niveles[i - 1]]);
    }
  });

  it('respeta los rangos publicados por Cambridge', () => {
    expect(GUIDED_HOURS_TO_REACH.A2).toBeGreaterThanOrEqual(180);
    expect(GUIDED_HOURS_TO_REACH.A2).toBeLessThanOrEqual(200);
    expect(GUIDED_HOURS_TO_REACH.B1).toBeGreaterThanOrEqual(350);
    expect(GUIDED_HOURS_TO_REACH.B1).toBeLessThanOrEqual(400);
    expect(GUIDED_HOURS_TO_REACH.B2).toBeGreaterThanOrEqual(500);
    expect(GUIDED_HOURS_TO_REACH.B2).toBeLessThanOrEqual(600);
    expect(GUIDED_HOURS_TO_REACH.C1).toBeGreaterThanOrEqual(700);
    expect(GUIDED_HOURS_TO_REACH.C1).toBeLessThanOrEqual(800);
    expect(GUIDED_HOURS_TO_REACH.C2).toBeGreaterThanOrEqual(1000);
    expect(GUIDED_HOURS_TO_REACH.C2).toBeLessThanOrEqual(1200);
  });

  it('hoursBetween no devuelve negativos al bajar de nivel', () => {
    expect(hoursBetween('B1', 'B2')).toBe(175);
    expect(hoursBetween('B2', 'B1')).toBe(0);
    expect(hoursBetween('B1', 'B1')).toBe(0);
  });
});

// Estos son LOS NÚMEROS QUE VE EL ALUMNO. Si cambian sin querer, este test avisa.
describe('meses estimados (B1 → B2, 175 h)', () => {
  it('1 h/semana ≈ 29 meses, 2 h ≈ 15, 3 h ≈ 10', () => {
    const h = hoursBetween('B1', 'B2');
    expect(monthsFor(h, 1)).toBe(29);
    expect(monthsFor(h, 2)).toBe(15);
    expect(monthsFor(h, 3)).toBe(10);
  });

  it('doblar las horas parte el tiempo por la mitad (el argumento del banner)', () => {
    const h = hoursBetween('A2', 'B1');
    expect(monthsFor(h, 2) * 2).toBeGreaterThanOrEqual(monthsFor(h, 1) - 1);
    expect(monthsFor(h, 2) * 2).toBeLessThanOrEqual(monthsFor(h, 1) + 1);
  });

  it('nunca baja de 1 mes ni divide por cero', () => {
    expect(monthsFor(1, 5)).toBe(1);
    expect(monthsFor(175, 0)).toBe(0);
    expect(monthsFor(0, 2)).toBe(0);
  });

  it('la fórmula es la documentada: horas / (semanales × práctica × semanas)', () => {
    expect(monthsFor(175, 2)).toBe(Math.round(175 / (2 * PRACTICE_MULTIPLIER * WEEKS_PER_MONTH)));
  });
});

describe('fecha de llegada', () => {
  it('suma meses de calendario en UTC', () => {
    expect(arrivalLabel(15, HOY)).toBe('noviembre de 2027');
    expect(arrivalLabel(29, HOY)).toBe('enero de 2029');
    expect(arrivalLabel(1, HOY)).toBe('septiembre de 2026');
  });
});

describe('nivel objetivo', () => {
  it('un plan de examen apunta al nivel que certifica ese examen', () => {
    expect(detectTargetLevel(['Preparación FCE'], 'B1')).toEqual({ level: 'B2', source: 'examen' });
    expect(detectTargetLevel(['Curso Advanced'], 'B2')).toEqual({ level: 'C1', source: 'examen' });
    expect(detectTargetLevel(['Proficiency'], 'C1')).toEqual({ level: 'C2', source: 'examen' });
    expect(detectTargetLevel(['Preparación IELTS'], 'B1')).toEqual({ level: 'B2', source: 'examen' });
  });

  it('CAE y PET sólo cuentan en mayúsculas (son palabras españolas corrientes)', () => {
    expect(detectTargetLevel(['Preparación CAE'], 'B2')).toEqual({ level: 'C1', source: 'examen' });
    // "cae" dentro de texto libre del objetivo NO puede disparar un C1.
    expect(detectTargetLevel(['Quiero que se me cae la vergüenza al hablar'], 'A2'))
      .toEqual({ level: 'B1', source: 'siguiente_nivel' });
  });

  it('sin examen, apunta al siguiente peldaño', () => {
    expect(detectTargetLevel(['Inglés general'], 'A2')).toEqual({ level: 'B1', source: 'siguiente_nivel' });
  });

  // 32 de las 184 assignments reales escriben el nivel del examen, no su nombre.
  it('lee el nivel escrito en el plan cuando no se nombra el examen', () => {
    expect(detectTargetLevel(['B2 Exámenes'], 'B1')).toEqual({ level: 'B2', source: 'examen' });
    expect(detectTargetLevel(['B2 Exámenes'], 'A2')).toEqual({ level: 'B2', source: 'examen' });
    expect(detectTargetLevel(['Preparación B1'], 'A2')).toEqual({ level: 'B1', source: 'examen' });
  });

  it('un código MCER sin contexto de examen NO es una meta', () => {
    // "B1" aquí es el nivel al que ya da clase, no a donde va.
    expect(detectTargetLevel(['Curso de inglés general - 2h semanales, B1'], 'A2'))
      .toEqual({ level: 'B1', source: 'siguiente_nivel' });
    expect(detectTargetLevel(['Curso de inglés general - 2h semanales, C1'], 'A2'))
      .toEqual({ level: 'B1', source: 'siguiente_nivel' });
  });

  it('con dos códigos no adivina', () => {
    expect(detectTargetLevel(['B1 Exámenes', 'quiere llegar al C1'], 'A2'))
      .toEqual({ level: 'B1', source: 'siguiente_nivel' });
  });

  it('quien ya está en el nivel del examen que prepara no tiene escalón que estimar', () => {
    expect(detectTargetLevel(['B1 Exámenes'], 'B1')).toBeNull();
    expect(detectTargetLevel(['Preparación B1 Preliminary'], 'B1')).toBeNull();
    expect(detectTargetLevel(['Preparación C1 Advanced'], 'C1')).toBeNull();
  });

  it('un examen por debajo del nivel actual es un dato incoherente y se ignora', () => {
    // Alumno ya en C1 con un plan de First: el B2 no es una meta, es su pasado.
    expect(detectTargetLevel(['Preparación FCE'], 'C1')).toEqual({ level: 'C2', source: 'siguiente_nivel' });
  });

  it('en C2 no hay nada por encima que prometer', () => {
    expect(detectTargetLevel(['Inglés general'], 'C2')).toBeNull();
  });
});

describe('buildEstimate', () => {
  const base = { currentLevel: 'B1', weeklyHours: 1, planTexts: ['Inglés general'], now: HOY };

  it('arma el caso completo de un alumno de 1 h/semana', () => {
    const e = buildEstimate(base)!;
    expect(e).not.toBeNull();
    expect(e.currentLevel).toBe('B1');
    expect(e.target.level).toBe('B2');
    expect(e.hoursNeeded).toBe(175);
    expect(e.hasUpgrade).toBe(true);
    expect(e.options.map(o => o.weeklyHours)).toEqual([1, 2, 3]);
    expect(e.options.map(o => o.months)).toEqual([29, 15, 10]);
    expect(e.options.map(o => o.monthsSaved)).toEqual([0, 14, 19]);
    expect(e.options[0].isCurrent).toBe(true);
  });

  it('la barra del plan actual siempre es la más larga', () => {
    const e = buildEstimate(base)!;
    expect(e.options[0].barPct).toBe(100);
    for (const o of e.options.slice(1)) expect(o.barPct).toBeLessThan(100);
  });

  it('nunca propone más de MAX_WEEKLY_HOURS', () => {
    const e = buildEstimate({ ...base, weeklyHours: 4 })!;
    expect(e.options.map(o => o.weeklyHours)).toEqual([4, 5]);
    expect(Math.max(...e.options.map(o => o.weeklyHours))).toBeLessThanOrEqual(MAX_WEEKLY_HOURS);
  });

  it('en el plan más alto no hay nada que vender', () => {
    const e = buildEstimate({ ...base, weeklyHours: 5 })!;
    expect(e.hasUpgrade).toBe(false);
    expect(e.options).toHaveLength(1);
  });

  it('normaliza niveles escritos de cualquier manera', () => {
    expect(buildEstimate({ ...base, currentLevel: 'b1' })?.currentLevel).toBe('B1');
    expect(buildEstimate({ ...base, currentLevel: 'Nivel B1 exámenes' })?.currentLevel).toBe('B1');
  });

  // NULL NO ES CERO: sin dato, no se enseña el bloque.
  it('devuelve null cuando falta el nivel', () => {
    expect(buildEstimate({ ...base, currentLevel: null })).toBeNull();
    expect(buildEstimate({ ...base, currentLevel: 'intermedio' })).toBeNull();
  });

  it('devuelve null cuando faltan las horas del plan', () => {
    expect(buildEstimate({ ...base, weeklyHours: null })).toBeNull();
    expect(buildEstimate({ ...base, weeklyHours: 0 })).toBeNull();
  });

  it('devuelve null cuando el alumno ya está arriba del todo', () => {
    expect(buildEstimate({ ...base, currentLevel: 'C2' })).toBeNull();
  });

  it('devuelve null cuando prepara el examen de su propio nivel', () => {
    expect(buildEstimate({ ...base, planTexts: ['B1 Exámenes'] })).toBeNull();
  });

  it('un alumno de examen apunta al examen, no al siguiente peldaño', () => {
    const e = buildEstimate({ ...base, currentLevel: 'A2', planTexts: ['B2 Exámenes'] })!;
    expect(e.target).toEqual({ level: 'B2', source: 'examen' });
    expect(e.hoursNeeded).toBe(360);   // A2 (190) → B2 (550)
  });
});
