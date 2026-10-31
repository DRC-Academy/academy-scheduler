import { describe, expect, it } from 'vitest';
import { CONFIG_POR_DEFECTO as C, type ClipMeasures } from '@/lib/testimonialMeasures';
import {
  selectListenClasses, pickTurns, listenPairs, clipBounds, contrastScore,
  type ListenClass, type ListenSegment, type ListenPlanSegment,
} from '@/lib/testimonialListenRank';
import type { Turn } from '@/lib/fluency';

const cls = (day: string, teacher = 't7', id = `ca_${day}`): ListenClass =>
  ({ analysisId: id, studentGroup: 's1', teacherId: teacher, classDay: day, fathomUrl: 'https://fathom.video/share/x' });

describe('selectListenClasses', () => {
  const dias = ['2026-07-20', '2026-07-27', '2026-08-03', '2026-08-10', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05'];
  it('3 primeras y 3 últimas grabadas', () => {
    expect(selectListenClasses(dias.map(d => cls(d)), C).map(x => x.classDay))
      .toEqual(['2026-07-20', '2026-07-27', '2026-08-03', '2026-09-21', '2026-09-28', '2026-10-05']);
  });
  it('con 5 clases se reparten sin solaparse (2 y 2)', () => {
    expect(selectListenClasses(dias.slice(0, 5).map(d => cls(d)), C)).toHaveLength(4);
  });
  it('nada si entre la primera y la última no hay las semanas mínimas', () => {
    expect(selectListenClasses(dias.slice(0, 3).map(d => cls(d)), C)).toEqual([]);
    expect(selectListenClasses([cls('2026-07-20')], C)).toEqual([]);
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
    expect(listenPairs([pseg('a', '2026-07-20', TRABADO), pseg('b', '2026-10-05', { ...FLUIDO, ppm: 115, habla_s: 10 })], C)).toEqual([]);
  });
  it('fuera los tramos en español, con otra voz, sin voz o bloqueados', () => {
    const b = pseg('b', '2026-10-05', FLUIDO);
    expect(listenPairs([pseg('es', '2026-07-20', { ...TRABADO, espanol_pct: 0.4 }), b], C)).toEqual([]);
    expect(listenPairs([pseg('voz', '2026-07-21', { ...TRABADO, otra_voz_palabras: 9 }), b], C)).toEqual([]);
    expect(listenPairs([pseg('nada', '2026-07-22', null), b], C)).toEqual([]);
    expect(listenPairs([pseg('a', '2026-07-20', TRABADO), b], C, { blocked: s => s.id === 'a' })).toEqual([]);
    expect(listenPairs([pseg('a', '2026-07-20', TRABADO), b], C, { skipPair: () => true })).toEqual([]);
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
  it('el clip es donde habla el alumno, con tope', () => {
    expect(clipBounds(seg('x', '2026-10-05', FLUIDO), C)).toEqual({ start: 100, end: 130 });
  });
  it('más contraste, más puntos', () => {
    expect(contrastScore(TRABADO, FLUIDO)).toBeGreaterThan(contrastScore(TRABADO, { ...FLUIDO, ppm: 110 }));
  });
});
