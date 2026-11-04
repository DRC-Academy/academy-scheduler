import { describe, expect, it } from 'vitest';
import { CONFIG_POR_DEFECTO as C, type ClipMeasures } from '@/lib/testimonialMeasures';
import {
  listenDone,
  listenableClasses, pickTurns, turnCandidates, listenPairs, clipBounds, contrastScore, progresoMedio, ordenarPorProgreso,
  type ListenClass, type ListenSegment, type ListenPlanSegment,
} from '@/lib/testimonialListenRank';
import type { Turn } from '@/lib/fluency';

const cls = (day: string, teacher = 't7', id = `ca_${day}`): ListenClass =>
  ({ analysisId: id, studentGroup: 's1', teacherId: teacher, classDay: day, fathomUrl: 'https://fathom.video/share/x' });

describe('listenableClasses', () => {
  const rec = (x: ListenClass) => x.analysisId.replace(/_copia$/, '');
  it('todas las clases del profe con 4+ semanas, una por grabación', () => {
    const l = [cls('2026-07-20'), cls('2026-07-20', 't7', 'ca_2026-07-20_copia'), cls('2026-08-03'), cls('2026-09-28')];
    expect(listenableClasses(l, C, rec).map(x => x.analysisId)).toEqual(['ca_2026-07-20', 'ca_2026-08-03', 'ca_2026-09-28']);
  });
  it('nada de un profe con menos de 4 semanas con el alumno (no puede salir pareja)', () => {
    const l = [cls('2026-07-20'), cls('2026-09-28'), cls('2026-08-03', 't9'), cls('2026-08-10', 't9')];
    expect(listenableClasses(l, C, rec).map(x => x.teacherId)).toEqual(['t7', 't7']);
    expect(listenableClasses([cls('2026-07-20')], C, rec)).toEqual([]);
  });
});

describe('pickTurns', () => {
  const PROFE = 'Lily (lily@gmail.com)', AL = 'Ana López';
  const T = (at: string, speaker: string, text: string): Turn => ({ at, speaker, text });
  const turns: Turn[] = [
    T('0:00', PROFE, 'Hi Ana, how was your weekend?'),
    T('0:05', AL, 'It was good, I went to the beach with my family'),            // 25 s
    T('0:30', PROFE, 'Nice. Now please read paragraph two aloud.'),
    T('0:40', AL, 'The industrial revolution began in Britain'),                 // 60 s pero lectura
    T('1:40', PROFE, 'Great. What do you think about it?'),
    T('1:45', AL, 'I think it changed everything'),                              // 10 s: corto
    T('1:55', PROFE, 'Tell me about your job'),
    T('2:00', AL, 'I work in a hospital, I am a nurse, and every day'),          // 100 s
    T('3:40', PROFE, 'Wow'),
  ];
  it('las intervenciones largas del alumno, sin lecturas ni cortas, con tope y margen', () => {
    expect(pickTurns(turns, AL, C)).toEqual([
      { turnIndex: 1, start: 3, dur: 27 },
      { turnIndex: 7, start: 118, dur: 47 },
    ]);
  });
  it('respeta el número de tramos por clase', () => {
    expect(pickTurns(turns, AL, { ...C, escucha_tramos_por_clase: 1 })).toEqual([{ turnIndex: 7, start: 118, dur: 47 }]);
  });
  it('con la lista de espontáneos, solo esos (aunque haya otros más largos)', () => {
    expect(turnCandidates(turns, AL, C).map(x => x.turnIndex)).toEqual([1, 7]);
    expect(pickTurns(turns, AL, { ...C, escucha_tramos_por_clase: 1 }, new Set([1]))).toEqual([{ turnIndex: 1, start: 3, dur: 27 }]);
    expect(pickTurns(turns, AL, C, new Set())).toEqual([]);
  });
});


const M = (over: Partial<ClipMeasures>): ClipMeasures => ({
  palabras: 30, habla_s: 15, ppm: 120, pausas: 0, pausas_min: 0, pausa_max_s: 0, muletillas: 0,
  repetidas_distintas: 0, unicas: 0.9, tercios_con_traba: 0, tercio_ppm_max: 130, otra_voz_palabras: 0, voces: 1,
  espanol_pct: 0, idioma: null, idioma_conf: null, ...over,
});
const TRABADO = M({ ppm: 70, pausas: 5, pausas_min: 15, pausa_max_s: 1.4, tercios_con_traba: 3, tercio_ppm_max: 90, habla_s: 20, muletillas: 4 });
const FLUIDO = M({ ppm: 140, pausas: 1, pausas_min: 2, pausa_max_s: 0.7, habla_s: 30 });
const seg = (id: string, day: string, medidas: ClipMeasures | null, teacher = 't7'): ListenSegment =>
  ({ id, analysisId: `ca_${day}`, teacherId: teacher, classDay: day, hablaStart: 100, hablaEnd: 140, medidas, texto: '' });

const pseg = (id: string, day: string, medidas: ClipMeasures | null, teacher = 't7', rec = `rec_${day}`): ListenPlanSegment =>
  ({ ...seg(id, day, medidas, teacher), moment: `${rec}#${id}`, recording: rec });

describe('a igual calidad, el DESPUÉS más largo', () => {
  const a = pseg('a', '2026-07-20', TRABADO);
  it('dentro de la misma franja de contraste gana el DESPUÉS de más segundos', () => {
    const r = listenPairs([a, pseg('corto', '2026-10-05', { ...FLUIDO, ppm: 142, habla_s: 12 }), pseg('largo', '2026-10-06', { ...FLUIDO, ppm: 140, habla_s: 27 })], C);
    expect(r.map(p => p.b.id)).toEqual(['largo', 'corto']);
  });
  it('un contraste claramente mejor sigue por delante aunque sea más corto', () => {
    const r = listenPairs([a, pseg('corto', '2026-10-05', { ...FLUIDO, ppm: 280, habla_s: 12 }), pseg('largo', '2026-10-06', { ...FLUIDO, ppm: 110, habla_s: 27 })], C);
    expect(r.map(p => p.b.id)).toEqual(['corto', 'largo']);
  });
});

describe('progresoMedio', () => {
  const m = (ppm: number) => M({ palabras: ppm, habla_s: 60, ppm });
  const s = (rec: string, day: string, ppm: number, teacher = 't7') => ({ recording: rec, classDay: day, teacherId: teacher, medidas: m(ppm) });
  it('compara las primeras clases con las últimas del profe con más clases, ponderado por palabras', () => {
    const r = progresoMedio([
      s('r1', '2026-07-01', 70), s('r2', '2026-07-08', 70), s('r3', '2026-07-15', 70),
      s('r4', '2026-09-01', 95), s('r5', '2026-09-08', 95), s('r6', '2026-09-15', 95),
      s('otro', '2026-09-20', 200, 't9'),
    ], C);
    expect(r).toEqual({ antes: 70, despues: 95, factor: 1.36, clases: 6 });
  });
  it('una copia de la misma grabación cuenta como una clase', () => {
    expect(progresoMedio([s('r1', '2026-07-01', 70), s('r1', '2026-09-01', 90)], C)).toBeNull();
  });
  it('sin 4 semanas entre la primera y la última, null', () => {
    expect(progresoMedio([s('r1', '2026-09-01', 70), s('r2', '2026-09-10', 90)], C)).toBeNull();
  });
  it('fuera lecturas, español y clips sin voz', () => {
    const r = progresoMedio([
      s('r1', '2026-07-01', 70), s('r2', '2026-09-01', 90),
      { ...s('r2', '2026-09-01', 300), lectura: 'lectura' as const },
      { recording: 'r2', classDay: '2026-09-01', teacherId: 't7', medidas: M({ palabras: 300, habla_s: 60, ppm: 300, espanol_pct: 0.5 }) },
      { recording: 'r2', classDay: '2026-09-01', teacherId: 't7', medidas: null },
    ], C);
    expect(r?.despues).toBe(90);
  });
});

describe('ordenarPorProgreso', () => {
  const t = (id: string, factor: number | null, juez_nota: number | null) => ({ id, juez_nota, progreso: factor == null ? null : { antes: 70, despues: 90, factor, clases: 6 } });
  it('primero los que mejoran ×1,15 o más; dentro de cada grupo, por nota; sin nota al final', () => {
    const r = ordenarPorProgreso([t('bajo-alta', 1.01, 90), t('sin', null, 95), t('real-baja', 1.2, 55), t('real-alta', 1.15, 72), t('real-sin', 1.3, null)], 1.15);
    expect(r.map(x => x.id)).toEqual(['real-alta', 'real-baja', 'real-sin', 'sin', 'bajo-alta']);
  });
});

describe('listenPairs', () => {
  it('ANTES trabado y DESPUÉS fluido, el de más contraste primero', () => {
    const r = listenPairs([
      pseg('a1', '2026-07-20', TRABADO), pseg('a2', '2026-07-27', { ...TRABADO, ppm: 90 }),
      pseg('b1', '2026-10-05', FLUIDO), pseg('b2', '2026-10-06', { ...FLUIDO, ppm: 130 }),
    ], C);
    expect(r.map(p => `${p.a.id}-${p.b.id}`)).toEqual(['a1-b1', 'a1-b2', 'a2-b1', 'a2-b2']);
    expect(r[0].semanas).toBe(11);
  });
  it('fuera: otro profe, la misma grabación, pocas semanas o sin contraste', () => {
    expect(listenPairs([pseg('a', '2026-07-20', TRABADO, 'otro'), pseg('b', '2026-10-05', FLUIDO)], C)).toEqual([]);
    expect(listenPairs([pseg('a', '2026-07-20', TRABADO, 't7', 'r'), pseg('b', '2026-10-05', FLUIDO, 't7', 'r')], C)).toEqual([]);
    expect(listenPairs([pseg('a', '2026-09-20', TRABADO), pseg('b', '2026-10-05', FLUIDO)], C)).toEqual([]);
    expect(listenPairs([pseg('a', '2026-07-20', TRABADO), pseg('b', '2026-10-05', { ...FLUIDO, ppm: 95 })], C)).toEqual([]);
    expect(listenPairs([pseg('a', '2026-07-20', TRABADO), pseg('b', '2026-10-05', { ...FLUIDO, habla_s: 8 })], C)).toEqual([]);
  });
  it('un DESPUÉS más corto que el ANTES vale (03/11/2026), si dura al menos 10 s', () => {
    expect(listenPairs([pseg('a', '2026-07-20', TRABADO), pseg('b', '2026-10-05', { ...FLUIDO, habla_s: 12 })], C)).toHaveLength(1);
  });
  it('fuera los tramos en español, con otra voz, sin voz o bloqueados', () => {
    const b = pseg('b', '2026-10-05', FLUIDO);
    expect(listenPairs([pseg('es', '2026-07-20', { ...TRABADO, espanol_pct: 0.4 }), b], C)).toEqual([]);
    expect(listenPairs([pseg('voz', '2026-07-21', { ...TRABADO, otra_voz_palabras: 9 }), b], C)).toEqual([]);
    expect(listenPairs([pseg('nada', '2026-07-22', null), b], C)).toEqual([]);
    expect(listenPairs([pseg('a', '2026-07-20', TRABADO), b], C, { blocked: s => s.id === 'a' })).toEqual([]);
    expect(listenPairs([pseg('a', '2026-07-20', TRABADO), b], C, { skipPair: () => true })).toEqual([]);
  });
  it('una lectura en voz alta nunca es DESPUÉS', () => {
    const a = pseg('a', '2026-07-20', TRABADO);
    expect(listenPairs([a, { ...pseg('b', '2026-10-05', FLUIDO), lectura: 'lectura' }], C)).toEqual([]);
    expect(listenPairs([a, { ...pseg('b', '2026-10-05', FLUIDO), lectura: 'espontaneo' }], C)).toHaveLength(1);
  });
  it('con algo de español (por debajo del máximo), al final', () => {
    const r = listenPairs([
      pseg('a1', '2026-07-20', { ...TRABADO, espanol_pct: 0.05 }), pseg('a2', '2026-07-27', { ...TRABADO, ppm: 90 }),
      pseg('b', '2026-10-05', FLUIDO),
    ], C);
    expect(r.map(p => p.a.id)).toEqual(['a2', 'a1']);
    expect(r[1].conEspanol).toBe(true);
  });
});

describe('clipBounds y contrastScore', () => {
  it('el clip es exactamente el trozo medido (el tope se aplica al medir)', () => {
    expect(clipBounds(seg('x', '2026-10-05', FLUIDO))).toEqual({ start: 100, end: 140 });
  });
  it('más contraste, más puntos', () => {
    expect(contrastScore(TRABADO, FLUIDO)).toBeGreaterThan(contrastScore(TRABADO, { ...FLUIDO, ppm: 110 }));
  });
});

describe('listenDone', () => {
  it('las escuchadas con el criterio viejo vuelven a la cola; sin tramos y enlace roto no', () => {
    expect(listenDone({ status: 'escuchada', criterio: 2 })).toBe(true);
    expect(listenDone({ status: 'escuchada', criterio: 1 })).toBe(false);
    expect(listenDone({ status: 'escuchada', criterio: null })).toBe(false);
    expect(listenDone({ status: 'sin_tramos', criterio: 1 })).toBe(true);
    expect(listenDone({ status: 'enlace_roto' })).toBe(true);
    expect(listenDone({ status: 'error', criterio: 2 })).toBe(false);
  });
});
