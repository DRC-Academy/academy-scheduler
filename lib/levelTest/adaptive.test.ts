import { describe, it, expect } from 'vitest';
import { getNextDifficulty, selectNextQuestion } from './adaptive';
import { SECTION_ORDER, SECTION_COUNT, START_DIFFICULTY } from './constants';
import type { LTSection } from './types';

// Banco simulado: `porNivel` preguntas de cada dificultad 1-6 en cada sección de
// lectura. Con porNivel=2 reproduce el banco actual de textos y emails; con 5, el
// que va a quedar después del seed nuevo.
interface Q { id: string; section: string; difficulty: number }
function banco(porNivel: number): Q[] {
  const out: Q[] = [];
  for (const sec of SECTION_ORDER) {
    if (sec === 'writing') continue;
    for (let d = 1; d <= 6; d++) {
      for (let i = 0; i < porNivel; i++) out.push({ id: `${sec}-d${d}-${i}`, section: sec, difficulty: d });
    }
  }
  return out;
}

/**
 * Recorre las tres secciones de lectura como lo hace computeNext: sirve preguntas
 * hasta completar el cupo de cada bloque, moviendo la dificultad con el escalón
 * real. `acierta` decide la respuesta a partir de la dificultad servida.
 */
function correrLectura(pool: Q[], acierta: (dificultad: number) => boolean) {
  const servidas: Array<{ id: string; section: string; target: number; served: number; ok: boolean }> = [];
  const answeredIds: string[] = [];
  let dificultad = START_DIFFICULTY;
  let agotado = false;

  for (const sec of SECTION_ORDER) {
    if (sec === 'writing') continue;
    for (let i = 0; i < SECTION_COUNT[sec]; i++) {
      const q = selectNextQuestion(pool, sec as LTSection, dificultad, answeredIds);
      if (!q) { agotado = true; break; }
      const ok = acierta(q.difficulty);
      servidas.push({ id: q.id, section: q.section, target: dificultad, served: q.difficulty, ok });
      answeredIds.push(q.id);
      dificultad = getNextDifficulty(dificultad, ok);
    }
    if (agotado) break;
  }
  return { servidas, agotado };
}

const totalLectura = SECTION_ORDER
  .filter(s => s !== 'writing')
  .reduce((n, s) => n + SECTION_COUNT[s], 0);

describe('getNextDifficulty', () => {
  it('sube al acertar y baja al fallar', () => {
    expect(getNextDifficulty(3, true)).toBe(4);
    expect(getNextDifficulty(3, false)).toBe(2);
  });
  it('no se sale de 1-6', () => {
    expect(getNextDifficulty(6, true)).toBe(6);
    expect(getNextDifficulty(1, false)).toBe(1);
  });
});

// El caso pedido: un alumno cuyo techo es la dificultad 3 oscila entre 3 y 4
// durante las 16 preguntas. Es el patrón normal de un adaptativo, no un extremo.
describe('integración — alumno oscilando entre dificultad 3 y 4', () => {
  const acierta = (d: number) => d <= 3;

  it('completa las 16 preguntas con el banco ACTUAL (2 por nivel en textos y emails)', () => {
    const { servidas, agotado } = correrLectura(banco(2), acierta);
    expect(agotado).toBe(false);
    expect(servidas).toHaveLength(totalLectura);
  });

  it('no repite ninguna pregunta', () => {
    const { servidas } = correrLectura(banco(2), acierta);
    expect(new Set(servidas.map(s => s.id)).size).toBe(servidas.length);
  });

  it('respeta el cupo de cada bloque', () => {
    const { servidas } = correrLectura(banco(2), acierta);
    for (const sec of SECTION_ORDER) {
      if (sec === 'writing') continue;
      expect(servidas.filter(s => s.section === sec)).toHaveLength(SECTION_COUNT[sec]);
    }
  });

  it('cada pregunta servida pertenece a la sección que tocaba', () => {
    const { servidas } = correrLectura(banco(2), acierta);
    const orden = SECTION_ORDER.filter(s => s !== 'writing');
    let i = 0;
    for (const sec of orden) {
      for (let n = 0; n < SECTION_COUNT[sec]; n++) expect(servidas[i++].section).toBe(sec);
    }
  });

  it('la dificultad servida es la registrable, y puede diferir de la pedida', () => {
    const { servidas } = correrLectura(banco(2), acierta);
    // Todas las servidas están en rango y son un número real, no el objetivo.
    for (const s of servidas) {
      expect(s.served).toBeGreaterThanOrEqual(1);
      expect(s.served).toBeLessThanOrEqual(6);
    }
    // Con el banco corto el desvío existe: es justo lo que target_difficulty
    // permite auditar. No se afirma que sea >0 porque depende del azar del
    // desempate, solo que el par (pedida, servida) queda disponible.
    expect(servidas.every(s => typeof s.target === 'number')).toBe(true);
  });

  it('con el banco objetivo (5 por nivel) el desvío desaparece', () => {
    const { servidas, agotado } = correrLectura(banco(5), acierta);
    expect(agotado).toBe(false);
    const desviadas = servidas.filter(s => s.served !== s.target);
    expect(desviadas).toHaveLength(0);
  });
});

// El techo es donde el banco corto duele: el clamp deja al alumno clavado en 6 y
// puede consumir el bloque entero en una sola dificultad.
describe('integración — alumno que se clava en el techo', () => {
  const acierta = () => true;

  it('con 2 por nivel NO puede servirle todo el bloque en dificultad 6', () => {
    const { servidas } = correrLectura(banco(2), acierta);
    const finales = servidas.slice(-8);
    expect(finales.some(s => s.served < s.target)).toBe(true);
  });

  it('con 5 por nivel sí, y la medición deja de estar sesgada hacia abajo', () => {
    const { servidas, agotado } = correrLectura(banco(5), acierta);
    expect(agotado).toBe(false);
    const finales = servidas.slice(-8);
    expect(finales.every(s => s.served === 6)).toBe(true);
  });
});

describe('selectNextQuestion — fallback', () => {
  const pool: Q[] = [
    { id: 'a', section: 'reading_passage', difficulty: 1 },
    { id: 'b', section: 'reading_passage', difficulty: 6 },
  ];

  it('sirve la más cercana cuando no hay del nivel pedido', () => {
    expect(selectNextQuestion(pool, 'reading_passage', 5, [])!.id).toBe('b');
    expect(selectNextQuestion(pool, 'reading_passage', 2, [])!.id).toBe('a');
  });

  it('nunca devuelve una ya respondida', () => {
    expect(selectNextQuestion(pool, 'reading_passage', 6, ['b'])!.id).toBe('a');
  });

  it('devuelve null solo cuando la sección entera está agotada', () => {
    expect(selectNextQuestion(pool, 'reading_passage', 3, ['a', 'b'])).toBeNull();
  });

  it('no cruza de sección', () => {
    expect(selectNextQuestion(pool, 'reading_email', 3, [])).toBeNull();
  });
});
