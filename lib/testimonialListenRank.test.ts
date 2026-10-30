import { describe, expect, it } from 'vitest';
import { CONFIG_POR_DEFECTO as C, type ClipMeasures } from '@/lib/testimonialMeasures';
import {
  selectClasses, commonTeachers, pickTurns, rankPair, clipBounds, contrastScore, daysBefore,
  type ListenClass, type ListenSegment,
} from '@/lib/testimonialListenRank';
import type { Turn } from '@/lib/fluency';

const cls = (day: string, teacher = 't7', id = `ca_${day}`): ListenClass =>
  ({ analysisId: id, studentGroup: 's1', teacherId: teacher, classDay: day, fathomUrl: 'https://fathom.video/share/x' });

describe('selectClasses', () => {
  const dias = ['2026-07-20', '2026-07-27', '2026-08-03', '2026-08-10', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05'];
  it('3 primeras y 3 últimas grabadas', () => {
    const r = selectClasses(dias.map(d => cls(d)), C, '2026-10-30');
    expect(r.ok && r.first.map(x => x.classDay)).toEqual(['2026-07-20', '2026-07-27', '2026-08-03']);
    expect(r.ok && r.last.map(x => x.classDay)).toEqual(['2026-09-21', '2026-09-28', '2026-10-05']);
  });
  it('con 5 clases se reparten sin solaparse (2 y 2)', () => {
    const r = selectClasses(dias.slice(0, 5).map(d => cls(d)), C, '2026-10-30');
    expect(r.ok && [r.first.length, r.last.length]).toEqual([2, 2]);
  });
  it('fuera: menos de 4 clases o menos de 2 meses desde la primera', () => {
    expect(selectClasses(dias.slice(0, 3).map(d => cls(d)), C, '2026-10-30')).toEqual({ ok: false, reason: 'pocas_clases' });
    expect(selectClasses(dias.map(d => cls(d)), C, '2026-09-01')).toEqual({ ok: false, reason: 'menos_2_meses' });
    expect(daysBefore('2026-10-30', 60)).toBe('2026-08-31');
  });
  it('profes en común entre primeras y últimas', () => {
    expect(commonTeachers({ first: [cls('2026-07-01', 'a'), cls('2026-07-02', 'b')], last: [cls('2026-10-01', 'b')] })).toEqual(['b']);
    expect(commonTeachers({ first: [cls('2026-07-01', 'a')], last: [cls('2026-10-01', 'c')] })).toEqual([]);
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

describe('rankPair', () => {
  it('elige el ANTES trabado y el DESPUÉS fluido con más contraste', () => {
    const r = rankPair(
      [seg('a1', '2026-07-20', TRABADO), seg('a2', '2026-07-27', { ...TRABADO, ppm: 90 })],
      [seg('b1', '2026-10-05', FLUIDO), seg('b2', '2026-10-06', { ...FLUIDO, ppm: 130 })],
      ['t7'], C);
    expect(r.ok && [r.a.id, r.b.id, r.semanas]).toEqual(['a1', 'b1', 11]);
  });
  it('sin profe en común no hay pareja', () => {
    expect(rankPair([seg('a', '2026-07-20', TRABADO)], [seg('b', '2026-10-05', FLUIDO)], [], C)).toEqual({ ok: false, reason: 'sin_profe_en_comun' });
  });
  it('motivos: sin tramo trabado, sin tramo fluido, poca distancia, sin contraste', () => {
    expect(rankPair([seg('a', '2026-07-20', FLUIDO)], [seg('b', '2026-10-05', FLUIDO)], ['t7'], C)).toMatchObject({ reason: 'sin_tramos_antes' });
    expect(rankPair([seg('a', '2026-07-20', TRABADO)], [seg('b', '2026-10-05', TRABADO)], ['t7'], C)).toMatchObject({ reason: 'sin_tramos_despues' });
    expect(rankPair([seg('a', '2026-09-20', TRABADO)], [seg('b', '2026-10-05', FLUIDO)], ['t7'], C)).toMatchObject({ reason: 'poca_distancia' });
    expect(rankPair([seg('a', '2026-07-20', TRABADO)], [seg('b', '2026-10-05', { ...FLUIDO, ppm: 115, habla_s: 10 })], ['t7'], C)).toMatchObject({ reason: 'sin_contraste' });
  });
  it('fuera los tramos en español, con otra voz o sin voz', () => {
    const r = rankPair(
      [seg('es', '2026-07-20', { ...TRABADO, espanol_pct: 0.4 }), seg('voz', '2026-07-21', { ...TRABADO, otra_voz_palabras: 9 }), seg('nada', '2026-07-22', null)],
      [seg('b', '2026-10-05', FLUIDO)], ['t7'], C);
    expect(r).toMatchObject({ ok: false, reason: 'sin_tramos_antes' });
  });
  it('solo con el profe en común', () => {
    const r = rankPair([seg('a', '2026-07-20', TRABADO, 'otro')], [seg('b', '2026-10-05', FLUIDO, 't7')], ['t7'], C);
    expect(r).toMatchObject({ ok: false, reason: 'sin_tramos_antes' });
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
