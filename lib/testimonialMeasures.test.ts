import { describe, expect, it } from 'vitest';
import {
  CONFIG_POR_DEFECTO as C, measureClip, checkAudio, checkAntes, checkDespues, checkContraste, checkVision,
  cutWindow, weeksBetween, isFiller, motivosFrase, shouldHarden, hardenedValue, mainSpeakerText,
  type ClipMeasures, type VisionSide,
} from '@/lib/testimonialMeasures';
import type { DeepgramTranscript, DeepgramWord } from '@/lib/deepgram';

/** Palabras seguidas desde `t0`, cada una de `dur` s, con `gap` s entre ellas (o los huecos indicados). */
function words(text: string, opts: { t0?: number; dur?: number; gap?: number | number[]; speaker?: number; lang?: string } = {}): DeepgramWord[] {
  const { t0 = 0, dur = 0.3, gap = 0.05, speaker = 0, lang = 'en' } = opts;
  let t = t0;
  return text.split(' ').map((w, i) => {
    const g = Array.isArray(gap) ? (gap[i] ?? 0.05) : gap;
    const out: DeepgramWord = { word: w.toLowerCase(), punctuated_word: w, start: t, end: t + dur, confidence: 0.9, speaker, language: lang };
    t += dur + g;
    return out;
  });
}

const T = (ws: DeepgramWord[], extra: Partial<DeepgramTranscript> = {}): DeepgramTranscript => ({
  requestId: null, durationS: 20, transcript: ws.map(w => w.word).join(' '), words: ws,
  languages: ['en'], detectedLanguage: null, languageConfidence: null, models: [], ...extra,
});

const M = (over: Partial<ClipMeasures>): ClipMeasures => ({
  palabras: 30, habla_s: 15, ppm: 120, pausas: 0, pausas_min: 0, pausa_max_s: 0, muletillas: 0,
  repetidas_distintas: 0, unicas: 0.9, tercios_con_traba: 0, tercio_ppm_max: 130, otra_voz_palabras: 0, voces: 1,
  espanol_pct: 0, idioma: 'en', idioma_conf: 0.95, ...over,
});

describe('cutWindow', () => {
  it('añade el margen y respeta el mínimo y el máximo', () => {
    expect(cutWindow(100, 108, C)).toEqual({ start: 98, dur: 12 });
    expect(cutWindow(1, 3, C)).toEqual({ start: 0, dur: 8 });
    expect(cutWindow(100, 160, C)).toEqual({ start: 98, dur: 35 });
  });
});

describe('isFiller', () => {
  it('reconoce um/uh/eh/hmm y no "am" ni "I"', () => {
    for (const w of ['um', 'Uhh', 'eh', 'hmm', 'mm-hmm', 'erm']) expect(isFiller(w)).toBe(true);
    for (const w of ['am', 'I', 'them', 'a']) expect(isFiller(w)).toBe(false);
  });
});

describe('measureClip', () => {
  it('fluido: velocidad alta, sin pausas', () => {
    const m = measureClip(T(words('I went to the market yesterday and I bought some fresh fruit for my family because we love it')), null, C)!;
    expect(m.palabras).toBe(19);
    expect(m.pausas).toBe(0);
    expect(m.ppm).toBeGreaterThan(150);
    expect(m.voces).toBe(1);
    expect(m.espanol_pct).toBe(0);
  });

  it('trabado: cuenta pausas, muletillas y tercios con traba', () => {
    const ws = words('I um went to uh the the market and um I', { gap: [0.9, 0.1, 0.1, 1.2, 0.1, 0.1, 1.0, 0.1, 0.8, 0.1] });
    const m = measureClip(T(ws), null, C)!;
    expect(m.muletillas).toBe(3);
    expect(m.pausas).toBe(4);
    expect(m.pausa_max_s).toBe(1.2);
    expect(m.tercios_con_traba).toBe(3);
    expect(m.palabras).toBe(8);
  });

  it('otra voz: mide solo al principal y cuenta las palabras ajenas; el hueco con otra voz no es pausa', () => {
    const alumno1 = words('So I think that', { t0: 0 });
    const profe = words('yes right exactly', { t0: 1.4, speaker: 1 });
    const alumno2 = words('it is very important for me', { t0: 3 });
    const m = measureClip(T([...alumno1, ...profe, ...alumno2]), null, C)!;
    expect(m.palabras).toBe(10);
    expect(m.otra_voz_palabras).toBe(3);
    expect(m.voces).toBe(2);
    expect(m.pausas).toBe(0);
  });

  it('español por palabra (multi) e idioma del clip (detect)', () => {
    const ws = [...words('I want to say', { t0: 0 }), ...words('cómo se dice soldado', { t0: 1.5, lang: 'es' })];
    const detect = T(words('I want to say como se dice soldado'), { detectedLanguage: 'en', languageConfidence: 0.7 });
    const m = measureClip(T(ws), detect, C)!;
    expect(m.espanol_pct).toBe(0.5);
    expect(m.idioma).toBe('en');
    expect(m.idioma_conf).toBe(0.7);
  });

  it('muletillas: si multi no las da, cuentan las de detect', () => {
    const multi = T(words('I went there'));
    const detect = T(words('I um went uh there'));
    expect(measureClip(multi, detect, C)!.muletillas).toBe(2);
  });

  it('palabras distintas repetidas seguidas (ejercicio) frente a un tartamudeo', () => {
    const ej = measureClip(T(words('delivered delivered past achieved achieved shift shift')), null, C)!;
    expect(ej.repetidas_distintas).toBe(3);
    const tart = measureClip(T(words('if if if if it rains we stay')), null, C)!;
    expect(tart.repetidas_distintas).toBe(1);
  });

  it('sin voz → null', () => {
    expect(measureClip(T([]), null, C)).toBeNull();
    expect(measureClip(T(words('um uh'))!, null, C)).toBeNull();
  });

  it('mainSpeakerText: solo el hablante principal, con puntuación', () => {
    const t = T([...words('Hello there friend.', { t0: 0 }), ...words('ok', { t0: 2, speaker: 1 })]);
    expect(mainSpeakerText(t)).toBe('Hello there friend.');
  });
});

describe('reglas de audio', () => {
  it('español por idioma detectado con confianza o por % de palabras', () => {
    expect(checkAudio(M({ idioma: 'es', idioma_conf: 0.92 }), 'ANTES', C)).toMatchObject({ ok: false, motivo: 'espanol' });
    expect(checkAudio(M({ idioma: 'es', idioma_conf: 0.6 }), 'ANTES', C).ok).toBe(true);
    expect(checkAudio(M({ espanol_pct: 0.2 }), 'ANTES', C)).toMatchObject({ ok: false, motivo: 'espanol' });
  });
  it('otra voz por encima de lo tolerado → habla_profe', () => {
    expect(checkAudio(M({ otra_voz_palabras: 3 }), 'DESPUÉS', C).ok).toBe(true);
    expect(checkAudio(M({ otra_voz_palabras: 4 }), 'DESPUÉS', C)).toMatchObject({ ok: false, motivo: 'habla_profe' });
  });
  it('ejercicio de repetición: varias palabras repetidas o lista con pocas distintas', () => {
    expect(checkAudio(M({ repetidas_distintas: 3 }), 'ANTES', C)).toMatchObject({ ok: false, motivo: 'ejercicio_repeticion' });
    expect(checkAudio(M({ palabras: 12, unicas: 0.4 }), 'ANTES', C)).toMatchObject({ ok: false, motivo: 'ejercicio_repeticion' });
    expect(checkAudio(M({ palabras: 6, unicas: 0.4 }), 'ANTES', C).ok).toBe(true);
  });
});

describe('ANTES, DESPUÉS y contraste', () => {
  const antes = M({ ppm: 70, pausas: 4, pausas_min: 16, tercios_con_traba: 3, tercio_ppm_max: 90, habla_s: 10 });
  const despues = M({ ppm: 130, pausas: 1, pausas_min: 3, pausa_max_s: 0.7, habla_s: 20 });

  it('un ANTES trabado de forma sostenida pasa; un tropiezo puntual no', () => {
    expect(checkAntes(antes, C).ok).toBe(true);
    expect(checkAntes({ ...antes, pausas: 1 }, C)).toMatchObject({ ok: false, motivo: 'falso_bloqueo' });
    expect(checkAntes({ ...antes, tercios_con_traba: 1 }, C)).toMatchObject({ ok: false, motivo: 'falso_bloqueo' });
    expect(checkAntes({ ...antes, tercio_ppm_max: 160 }, C)).toMatchObject({ ok: false, motivo: 'falso_bloqueo' });
    expect(checkAntes({ ...antes, ppm: 120 }, C)).toMatchObject({ ok: false, motivo: 'falso_bloqueo' });
  });
  it('DESPUÉS: sin pausas largas y rápido', () => {
    expect(checkDespues(despues, C).ok).toBe(true);
    expect(checkDespues({ ...despues, pausa_max_s: 1.5 }, C)).toMatchObject({ ok: false, motivo: 'sin_contraste' });
    expect(checkDespues({ ...despues, ppm: 90 }, C)).toMatchObject({ ok: false, motivo: 'sin_contraste' });
  });
  it('contraste: ×1,4 de velocidad, menos de la mitad de pausas por minuto y más largo', () => {
    expect(checkContraste(antes, despues, C).ok).toBe(true);
    expect(checkContraste(antes, { ...despues, ppm: 90 }, C)).toMatchObject({ ok: false, motivo: 'sin_contraste' });
    expect(checkContraste(antes, { ...despues, pausas_min: 9 }, C)).toMatchObject({ ok: false, motivo: 'sin_contraste' });
    expect(checkContraste(antes, { ...despues, habla_s: 8 }, C)).toMatchObject({ ok: false, motivo: 'sin_contraste' });
  });
  it('semanas entre clases', () => {
    expect(weeksBetween('2026-07-30', '2026-09-30')).toBe(8);
    expect(weeksBetween('2026-10-07', '2026-09-21')).toBeLessThan(0);
  });
});

describe('reglas de imagen', () => {
  const v = (over: Partial<VisionSide>): VisionSide => ({
    camara_alumno: 'encendida', camara_conf: 0.9, pantalla_compartida: false, recuadros_pequenos: false,
    leyendo: false, leyendo_conf: 0.1, nombre_que_habla: 'Nayara Cornejo P...', quien_habla_por_cara: 'no_se_sabe', ...over,
  });
  const isStudent = (n: string) => n.startsWith('Nayara');
  const isTeacher = (n: string) => n.startsWith('Iggy');

  it('el recuadro que habla es el del alumno → vale', () => {
    expect(checkVision(v({}), 'ANTES', C, isStudent, isTeacher).ok).toBe(true);
  });
  it('el recuadro que habla es el del profe → habla_profe', () => {
    expect(checkVision(v({ nombre_que_habla: 'Iggy Polo' }), 'ANTES', C, isStudent, isTeacher)).toMatchObject({ ok: false, motivo: 'habla_profe' });
  });
  it('sin nombre: manda la comparación con la foto del profe', () => {
    expect(checkVision(v({ nombre_que_habla: '', quien_habla_por_cara: 'profe' }), 'ANTES', C, isStudent, isTeacher)).toMatchObject({ ok: false, motivo: 'habla_profe' });
    expect(checkVision(v({ nombre_que_habla: '', quien_habla_por_cara: 'alumno' }), 'ANTES', C, isStudent, isTeacher).ok).toBe(true);
  });
  it('cámara apagada y lectura', () => {
    expect(checkVision(v({ camara_alumno: 'apagada', camara_conf: 0.8 }), 'ANTES', C, isStudent, isTeacher)).toMatchObject({ motivo: 'camara_apagada' });
    expect(checkVision(v({ pantalla_compartida: true, recuadros_pequenos: true }), 'ANTES', C, isStudent, isTeacher)).toMatchObject({ motivo: 'leyendo' });
    expect(checkVision(v({ pantalla_compartida: true, recuadros_pequenos: false }), 'ANTES', C, isStudent, isTeacher).ok).toBe(true);
    expect(checkVision(v({ leyendo: true, leyendo_conf: 0.7 }), 'ANTES', C, isStudent, isTeacher)).toMatchObject({ motivo: 'leyendo' });
  });
});

describe('aprendizaje y resúmenes', () => {
  it('motivosFrase', () => {
    expect(motivosFrase({ espanol: 14, habla_profe: 9, leyendo: 0 })).toBe('14 en español, 9 habla el profe');
  });
  it('shouldHarden: 3 veces en las últimas 20, contando solo después del último cambio', () => {
    const r = (motivo: string, d: number) => ({ motivo, at: `2026-10-${String(d).padStart(2, '0')}T10:00:00Z` });
    const reviews = [r('espanol', 1), r('espanol', 2), r('leyendo', 3), r('espanol', 4)];
    expect(shouldHarden(reviews, 'espanol', null, 20, 3)).toBe(true);
    expect(shouldHarden(reviews, 'espanol', '2026-10-02T12:00:00Z', 20, 3)).toBe(false);
    expect(shouldHarden(reviews, 'espanol', null, 2, 3)).toBe(false);
  });
  it('hardenedValue respeta el límite', () => {
    expect(hardenedValue(0.15, -0.03, 0.03)).toBe(0.12);
    expect(hardenedValue(0.04, -0.03, 0.03)).toBe(0.03);
    expect(hardenedValue(0.03, -0.03, 0.03)).toBeNull();
    expect(hardenedValue(3, 1, 8)).toBe(4);
  });
});
