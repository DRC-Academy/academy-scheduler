import { describe, expect, it } from 'vitest';
import {
  GUIDE_BANNER_UNTIL, PENALTY_GUIDE_STEPS, GUIDE_RULES, GUIDE_CASES,
  shouldShowGuideBanner, spainToday, type GuideBannerInput,
} from '@/lib/penaltyGuide';
import { MONTHLY_WILDCARDS, PENALTY_EUROS, NO_SHOW_PENALTY_EUROS } from '@/lib/classRecoveries';
import { ONBOARDING_STEPS } from '@/lib/onboarding';
import { cleanAiText } from '@/lib/textCleanup';

/** Espacio duro: el que une la cifra y su unidad en los textos ("24 h", "5 €"). */
const NBSP = ' ';

const base: GuideBannerInput = {
  role: 'teacher', today: '2026-10-22', completedAt: null, laterOn: null,
  tourOpen: false, autoOnboarding: false,
};

describe('shouldShowGuideBanner', () => {
  it('sale a un profesor que no terminó la guía', () => {
    expect(shouldShowGuideBanner(base)).toBe(true);
  });
  it('solo profesores: ni admin ni setter', () => {
    expect(shouldShowGuideBanner({ ...base, role: 'admin' })).toBe(false);
    expect(shouldShowGuideBanner({ ...base, role: 'setter' })).toBe(false);
    expect(shouldShowGuideBanner({ ...base, role: null })).toBe(false);
  });
  it('hasta el 01/11/2026 inclusive', () => {
    expect(GUIDE_BANNER_UNTIL).toBe('2026-11-01');
    expect(shouldShowGuideBanner({ ...base, today: '2026-11-01' })).toBe(true);
    expect(shouldShowGuideBanner({ ...base, today: '2026-11-02' })).toBe(false);
  });
  it('terminada, no vuelve nunca', () => {
    expect(shouldShowGuideBanner({ ...base, completedAt: '2026-10-22T10:00:00Z' })).toBe(false);
  });
  it('"Más tarde" la esconde ese día y vuelve al siguiente', () => {
    expect(shouldShowGuideBanner({ ...base, laterOn: '2026-10-22' })).toBe(false);
    expect(shouldShowGuideBanner({ ...base, laterOn: '2026-10-21' })).toBe(true);
  });
  it('no se junta con un recorrido abierto ni con el tutorial automático', () => {
    expect(shouldShowGuideBanner({ ...base, tourOpen: true })).toBe(false);
    expect(shouldShowGuideBanner({ ...base, autoOnboarding: true })).toBe(false);
  });
});

describe('spainToday', () => {
  it('usa la fecha de España, no la del navegador', () => {
    // 23:30 UTC del 01/11 = 00:30 del 02/11 en Madrid (horario de invierno, UTC+1).
    expect(spainToday(new Date('2026-11-01T23:30:00Z'))).toBe('2026-11-02');
    expect(spainToday(new Date('2026-11-01T22:30:00Z'))).toBe('2026-11-01');
  });
});

describe('pasos de la guía', () => {
  it('son 9, con ids únicos y que no chocan con los del tutorial', () => {
    expect(PENALTY_GUIDE_STEPS).toHaveLength(9);
    const ids = PENALTY_GUIDE_STEPS.map(s => s.id);
    expect(new Set(ids).size).toBe(9);
    const tutorial = new Set(ONBOARDING_STEPS.map(s => s.id as string));
    expect(ids.some(id => tutorial.has(id))).toBe(false);
  });
  it('el último botón dice "Entendido"', () => {
    expect(PENALTY_GUIDE_STEPS.at(-1)?.doneLabel).toBe('Entendido');
    expect(PENALTY_GUIDE_STEPS.slice(0, -1).every(s => !s.doneLabel)).toBe(true);
  });
  it('todo paso con elemento se muestra centrado si falta (nada se salta)', () => {
    expect(PENALTY_GUIDE_STEPS.every(s => s.onMissing === 'center')).toBe(true);
  });
  it('lo que abre un paso lo cierra el mismo paso (el menú ⋯)', () => {
    for (const s of PENALTY_GUIDE_STEPS) expect(!!s.onEnter).toBe(!!s.onExit);
  });
  it('las cifras salen de las reglas, no escritas a mano', () => {
    const noPuedo = PENALTY_GUIDE_STEPS.find(s => s.id === 'pg-no-puedo')!.body;
    expect(noPuedo).toContain(`${MONTHLY_WILDCARDS} gratis al mes`);
    expect(noPuedo).toContain(`${PENALTY_EUROS}${NBSP}€`);
    expect(PENALTY_GUIDE_STEPS.find(s => s.id === 'pg-falta')!.body).toContain(`${NO_SHOW_PENALTY_EUROS}${NBSP}€`);
  });
});

describe('centro de ayuda', () => {
  it('tabla de 3 reglas: más de 24 h, menos de 24 h, falta sin avisar', () => {
    // Espacio duro entre la cifra y la unidad: "24 h" no se parte en dos líneas.
    expect(GUIDE_RULES.rows.map(r => r[0])).toEqual([
      `Cancelas con más de 24${NBSP}h`, `Cancelas con menos de 24${NBSP}h`, 'Falta sin avisar (no cancelas y no entras)',
    ]);
  });
  it('ids de los casos únicos', () => {
    expect(new Set(GUIDE_CASES.map(c => c.id)).size).toBe(GUIDE_CASES.length);
  });
  it('ningún texto lleva guiones de conector (regla de los textos del profesor)', () => {
    const textos = [
      ...GUIDE_CASES.flatMap(c => [c.situation, c.action]),
      ...PENALTY_GUIDE_STEPS.flatMap(s => [s.title, s.body, s.bodyWhenMissing ?? '']),
    ];
    for (const t of textos) {
      expect(t).not.toMatch(/ [—–-] /);
      expect(cleanAiText(t)).toBe(t);
    }
  });
});
