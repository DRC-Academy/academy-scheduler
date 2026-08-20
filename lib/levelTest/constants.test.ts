import { describe, it, expect } from 'vitest';
import { CEFR_BANDS, scoreToCefr, cefrToScore, DIFFICULTY_TO_CEFR, CEFR_TO_DIFFICULTY } from './constants';
import type { Cefr, CefrPosition } from './types';

const NIVELES: Cefr[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const POSICIONES: CefrPosition[] = ['low', 'mid', 'high'];

// CEFR_BANDS es la única fuente de los umbrales: la escritura y la lectura
// derivan las dos de aquí. Si el invariante se rompe, las dos mitades del test
// dejan de hablar la misma escala en silencio, sin que falle nada más.
describe('invariante scoreToCefr(cefrToScore(L)) === L', () => {
  it('se sostiene en las 18 combinaciones', () => {
    const fallos: string[] = [];
    for (const nivel of NIVELES) {
      for (const pos of POSICIONES) {
        const score = cefrToScore(nivel, pos);
        const vuelta = scoreToCefr(score);
        if (vuelta !== nivel) fallos.push(`${nivel}/${pos} → ${score} → ${vuelta}`);
      }
    }
    expect(fallos).toEqual([]);
  });

  it('cada posición cae DENTRO de su banda, sin tocar los bordes', () => {
    for (const nivel of NIVELES) {
      const banda = CEFR_BANDS.find(b => b.level === nivel)!;
      for (const pos of POSICIONES) {
        const score = cefrToScore(nivel, pos);
        // Estrictamente dentro: las bandas son (min, max], así que caer justo en
        // el min lo mandaría a la banda de abajo.
        expect(score).toBeGreaterThan(banda.min);
        expect(score).toBeLessThanOrEqual(banda.max);
      }
    }
  });

  it('low < mid < high dentro de cada banda', () => {
    for (const nivel of NIVELES) {
      const [lo, mid, hi] = POSICIONES.map(p => cefrToScore(nivel, p));
      expect(lo).toBeLessThan(mid);
      expect(mid).toBeLessThan(hi);
    }
  });
});

describe('CEFR_BANDS — estructura', () => {
  it('están en orden y cubren 0–100 sin huecos ni solapes', () => {
    expect(CEFR_BANDS.map(b => b.level)).toEqual(NIVELES);
    expect(CEFR_BANDS[0].min).toBe(0);
    expect(CEFR_BANDS[CEFR_BANDS.length - 1].max).toBe(100);
    for (let i = 1; i < CEFR_BANDS.length; i++) {
      expect(CEFR_BANDS[i].min).toBe(CEFR_BANDS[i - 1].max);
    }
  });

  // Sextos iguales: la elección de umbrales dejó de ser una decisión sobre datos
  // y pasó a ser aritmética, porque las dos mitades del test ya vienen ancladas a
  // estas bandas. Antes A1 y C2 abarcaban 30 puntos y las cuatro centrales 10, o
  // sea que en la zona donde vive casi todo el alumnado dos puntos cambiaban el
  // nivel.
  it('las seis bandas miden lo mismo', () => {
    const anchos = CEFR_BANDS.map(b => b.max - b.min);
    for (const ancho of anchos) expect(ancho).toBeCloseTo(100 / 6, 6);
  });

  // Valores clavados a propósito. El punto medio de B1 era 45,00 con los umbrales
  // viejos y es el número contra el que se comparaban las verificaciones a mano;
  // con sextos iguales pasa a 41,67. Si alguien vuelve a mover las bandas, esto
  // salta y obliga a actualizar también esas comprobaciones.
  it('puntos medios de referencia con sextos iguales', () => {
    expect(cefrToScore('A1', 'mid')).toBeCloseTo(8.33, 2);
    expect(cefrToScore('A2', 'mid')).toBeCloseTo(25, 2);
    expect(cefrToScore('B1', 'mid')).toBeCloseTo(41.67, 2);   // antes 45,00
    expect(cefrToScore('B2', 'mid')).toBeCloseTo(58.33, 2);
    expect(cefrToScore('C1', 'mid')).toBeCloseTo(75, 2);
    expect(cefrToScore('C2', 'mid')).toBeCloseTo(91.67, 2);
  });

  it('scoreToCefr aguanta los extremos y lo que se salga de rango', () => {
    expect(scoreToCefr(0)).toBe('A1');
    expect(scoreToCefr(-5)).toBe('A1');
    expect(scoreToCefr(100)).toBe('C2');
    expect(scoreToCefr(1000)).toBe('C2');
  });

  it('cada frontera pertenece a la banda de ABAJO: los tramos son (min, max]', () => {
    for (let i = 0; i < CEFR_BANDS.length - 1; i++) {
      const frontera = CEFR_BANDS[i].max;
      expect(scoreToCefr(frontera)).toBe(CEFR_BANDS[i].level);
      expect(scoreToCefr(frontera + 0.01)).toBe(CEFR_BANDS[i + 1].level);
    }
  });
});

describe('mapa dificultad ↔ MCER', () => {
  it('las dificultades 1-6 mapean a las seis bandas, y de vuelta', () => {
    for (let d = 1; d <= 6; d++) {
      const nivel = DIFFICULTY_TO_CEFR[d];
      expect(nivel).toBe(NIVELES[d - 1]);
      expect(CEFR_TO_DIFFICULTY[nivel]).toBe(d);
    }
  });
});
