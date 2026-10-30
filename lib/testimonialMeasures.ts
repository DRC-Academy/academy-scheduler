// Testimoniales — MEDIDAS de fluidez y reglas del verificador. Módulo PURO.
//
// Entra lo que devuelve Deepgram para un clip (palabras con su segundo de inicio
// y fin, su voz y su idioma) y salen números que se pueden comprobar: palabras
// por minuto, pausas, muletillas, repeticiones, español. Las reglas que deciden
// (ANTES trabado de verdad, DESPUÉS fluido, contraste…) leen sus umbrales de
// testimonial_config, nunca de constantes del código.
//
// Desde el verificador, el texto que vale es el de Deepgram: el de Fathom solo
// sirvió para elegir dónde recortar.

import type { DeepgramTranscript, DeepgramWord } from '@/lib/deepgram';

/** Motivos de descarte. Los 9 primeros son también los de "No sirve" del admin. */
export const MOTIVOS = [
  'habla_profe', 'leyendo', 'camara_apagada', 'espanol', 'falso_bloqueo',
  'ejercicio_repeticion', 'sin_contraste', 'enlace_roto', 'otro', 'nota_baja', 'sin_voz',
] as const;
export type Motivo = typeof MOTIVOS[number];
export const MOTIVOS_ADMIN = MOTIVOS.slice(0, 9) as readonly Motivo[];

export const MOTIVO_LABEL: Record<Motivo, string> = {
  habla_profe: 'Habla el profe',
  leyendo: 'Leyendo',
  camara_apagada: 'Cámara apagada',
  espanol: 'En español',
  falso_bloqueo: 'Falso bloqueo',
  ejercicio_repeticion: 'Ejercicio de repetición',
  sin_contraste: 'Sin contraste',
  enlace_roto: 'Enlace roto',
  otro: 'Otro',
  nota_baja: 'Nota baja del juez',
  sin_voz: 'Sin voz en el clip',
};

/** Umbrales que usan las reglas (claves de testimonial_config). */
export interface VerifyConfig {
  recorte_margen_s: number; recorte_min_s: number; recorte_max_s: number;
  deepgram_ambas: number;
  espanol_confianza_min: number; espanol_pct_max: number; voces_otra_max_palabras: number;
  pausa_min_s: number;
  antes_pausas_min: number; antes_ppm_max: number; antes_tercio_ppm_max: number; antes_tercios_con_traba_min: number;
  despues_pausa_max_s: number; despues_ppm_min: number;
  repeticion_distintas_min: number; repeticion_unicas_max: number;
  contraste_ppm_factor: number; contraste_pausas_factor: number; semanas_min: number;
  vision_camara_conf: number; vision_leyendo_conf: number;
  juez_nota_min: number; parejas_por_tanda: number;
  endurecer_ventana: number; endurecer_veces: number; alarma_fuente_pct: number; retencion_dias: number;
}

/** Valores de supabase-testimoniales-verificador.sql: solo para lo que falte en la tabla. */
export const CONFIG_POR_DEFECTO: VerifyConfig = {
  recorte_margen_s: 2, recorte_min_s: 8, recorte_max_s: 35,
  deepgram_ambas: 1,
  espanol_confianza_min: 0.9, espanol_pct_max: 0.15, voces_otra_max_palabras: 3,
  pausa_min_s: 0.6,
  antes_pausas_min: 3, antes_ppm_max: 100, antes_tercio_ppm_max: 140, antes_tercios_con_traba_min: 2,
  despues_pausa_max_s: 1.0, despues_ppm_min: 110,
  repeticion_distintas_min: 3, repeticion_unicas_max: 0.5,
  contraste_ppm_factor: 1.4, contraste_pausas_factor: 0.5, semanas_min: 4,
  vision_camara_conf: 0.6, vision_leyendo_conf: 0.6,
  juez_nota_min: 60, parejas_por_tanda: 5,
  endurecer_ventana: 20, endurecer_veces: 3, alarma_fuente_pct: 0.5, retencion_dias: 30,
};

// ── Tramo que se recorta ─────────────────────────────────────────────────────

/** [inicio, duración] del recorte alrededor del clip que estimó el buscador. */
export function cutWindow(start: number, end: number, c: VerifyConfig): { start: number; dur: number } {
  const s = Math.max(0, start - c.recorte_margen_s);
  const e = Math.max(end + c.recorte_margen_s, s + c.recorte_min_s);
  return { start: s, dur: Math.round(Math.min(e - s, c.recorte_max_s) * 10) / 10 };
}

// ── Medidas ──────────────────────────────────────────────────────────────────

const FILLER = /^(u+m+|u+h+|m+|h+m+|e+r+m*|a+h+|e+h+|e+m+|m+h+m+|uh-huh|mm-hmm|mhm)$/i;
const norm = (w: string) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}']/gu, '');
export const isFiller = (w: string): boolean => FILLER.test(norm(w));

export interface ClipMeasures {
  /** Palabras del hablante principal sin contar muletillas. */
  palabras: number;
  /** Segundos desde su primera palabra hasta la última. */
  habla_s: number;
  ppm: number;
  pausas: number;
  pausas_min: number;
  pausa_max_s: number;
  muletillas: number;
  /** Palabras distintas dichas dos o más veces seguidas. */
  repetidas_distintas: number;
  /** Fracción de palabras distintas (1 = ninguna se repite). */
  unicas: number;
  /** Tercios del clip (de 3) con alguna pausa o muletilla. */
  tercios_con_traba: number;
  /** Palabras por minuto del tercio más rápido. */
  tercio_ppm_max: number;
  /** Palabras de otras voces (sin muletillas). */
  otra_voz_palabras: number;
  voces: number;
  /** Fracción de palabras en español (modo multi). null si Deepgram no da idioma por palabra. */
  espanol_pct: number | null;
  /** Modo detect: idioma de todo el clip y su confianza. */
  idioma: string | null;
  idioma_conf: number | null;
}

const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

/** Voz con más palabras y cuántas palabras dicen las demás. */
function dominant(words: DeepgramWord[]): { speaker: number | undefined; others: number; voices: number } {
  const count = new Map<number | undefined, number>();
  for (const w of words) if (!isFiller(w.word)) count.set(w.speaker, (count.get(w.speaker) ?? 0) + 1);
  let speaker: number | undefined, best = -1;
  for (const [s, n] of count) if (n > best) { speaker = s; best = n; }
  const total = [...count.values()].reduce((a, b) => a + b, 0);
  return { speaker, others: total - Math.max(best, 0), voices: count.size };
}

/**
 * Medidas de un clip. `multi` es la transcripción principal (idioma y voz por
 * palabra); `detect`, si existe, aporta el idioma del clip y sus muletillas (en
 * inglés la documentación de Deepgram solo garantiza las muletillas así).
 * null = no hay voz.
 */
export function measureClip(multi: DeepgramTranscript, detect: DeepgramTranscript | null, c: Pick<VerifyConfig, 'pausa_min_s'>): ClipMeasures | null {
  const all = multi.words;
  const dom = dominant(all);
  const mine = all.filter(w => w.speaker === dom.speaker);
  const content = mine.filter(w => !isFiller(w.word));
  if (content.length === 0) return null;

  const t0 = mine[0].start, t1 = mine[mine.length - 1].end;
  const habla = Math.max(0.5, t1 - t0);

  // Pausas: silencios entre palabras SEGUIDAS del hablante principal (si otra voz
  // habla en medio, ese hueco no es una pausa suya).
  const gaps: Array<{ at: number; dur: number }> = [];
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1], b = all[i];
    if (a.speaker !== dom.speaker || b.speaker !== dom.speaker) continue;
    const d = b.start - a.end;
    if (d >= c.pausa_min_s) gaps.push({ at: a.end, dur: d });
  }

  // Muletillas: las que vea cada modo, la cuenta más alta (multi puede no darlas).
  const fillersIn = (ws: DeepgramWord[], spk?: number) => ws.filter(w => isFiller(w.word) && (spk === undefined || w.speaker === spk));
  const fMulti = fillersIn(mine);
  const dDom = detect ? dominant(detect.words) : null;
  const fDetect = detect ? fillersIn(detect.words, dDom?.speaker) : [];
  const fillers = fDetect.length > fMulti.length ? fDetect : fMulti;

  const seq = content.map(w => norm(w.word)).filter(Boolean);
  const repetidas = new Set<string>();
  for (let i = 1; i < seq.length; i++) if (seq[i] === seq[i - 1]) repetidas.add(seq[i]);

  const third = habla / 3;
  const thirds = [0, 1, 2].map(k => {
    const from = t0 + k * third, to = from + third;
    const ws = content.filter(w => w.start >= from && w.start < to + (k === 2 ? 0.01 : 0)).length;
    const traba = gaps.some(g => g.at >= from && g.at < to) || fillers.some(f => f.start >= from && f.start < to);
    return { ppm: (ws / third) * 60, traba };
  });

  const langWords = content.filter(w => w.language);
  return {
    palabras: content.length,
    habla_s: round(habla),
    ppm: round((content.length / habla) * 60),
    pausas: gaps.length,
    pausas_min: round((gaps.length / habla) * 60),
    pausa_max_s: round(gaps.reduce((m, g) => Math.max(m, g.dur), 0), 2),
    muletillas: fillers.length,
    repetidas_distintas: repetidas.size,
    unicas: round(new Set(seq).size / Math.max(1, seq.length), 2),
    tercios_con_traba: thirds.filter(t => t.traba).length,
    tercio_ppm_max: round(Math.max(...thirds.map(t => t.ppm))),
    otra_voz_palabras: Math.max(dom.others, dDom?.others ?? 0),
    voces: Math.max(dom.voices, dDom?.voices ?? 0),
    espanol_pct: langWords.length ? round(langWords.filter(w => w.language === 'es').length / langWords.length, 2) : null,
    idioma: detect?.detectedLanguage ?? null,
    idioma_conf: detect?.languageConfidence ?? null,
  };
}

/** Texto del hablante principal (con puntuación), el que se enseña y lee el juez. */
export function mainSpeakerText(t: DeepgramTranscript): string {
  const dom = dominant(t.words);
  return t.words.filter(w => w.speaker === dom.speaker).map(w => w.punctuated_word ?? w.word).join(' ');
}

// ── Reglas ───────────────────────────────────────────────────────────────────

export type RuleResult = { ok: true } | { ok: false; motivo: Motivo; detalle: string };
const OK: RuleResult = { ok: true };
const no = (motivo: Motivo, detalle: string): RuleResult => ({ ok: false, motivo, detalle });
const pct = (x: number) => `${Math.round(x * 100)} %`;

/** Reglas del AUDIO de un clip (cualquiera de los dos lados). */
export function checkAudio(m: ClipMeasures, lado: 'ANTES' | 'DESPUÉS', c: VerifyConfig): RuleResult {
  if (m.idioma && m.idioma !== 'en' && (m.idioma_conf ?? 0) >= c.espanol_confianza_min) {
    return no('espanol', `${lado}: Deepgram oye ${m.idioma} con confianza ${m.idioma_conf?.toFixed(2)}.`);
  }
  if (m.espanol_pct != null && m.espanol_pct > c.espanol_pct_max) {
    return no('espanol', `${lado}: ${pct(m.espanol_pct)} de las palabras en español.`);
  }
  if (m.otra_voz_palabras > c.voces_otra_max_palabras) {
    return no('habla_profe', `${lado}: hay otra voz que dice ${m.otra_voz_palabras} palabras.`);
  }
  if (m.repetidas_distintas >= c.repeticion_distintas_min || (m.palabras >= 10 && m.unicas < c.repeticion_unicas_max)) {
    return no('ejercicio_repeticion', `${lado}: ${m.repetidas_distintas} palabras distintas repetidas seguidas, ${pct(m.unicas)} de palabras distintas.`);
  }
  return OK;
}

/** ANTES válido: trabado de forma sostenida, no un tropiezo puntual. */
export function checkAntes(m: ClipMeasures, c: VerifyConfig): RuleResult {
  const fallos: string[] = [];
  if (m.pausas < c.antes_pausas_min) fallos.push(`${m.pausas} pausas (mínimo ${c.antes_pausas_min})`);
  if (m.ppm > c.antes_ppm_max) fallos.push(`${m.ppm} palabras/min (máximo ${c.antes_ppm_max})`);
  if (m.tercios_con_traba < c.antes_tercios_con_traba_min) fallos.push(`traba en ${m.tercios_con_traba} de 3 tercios`);
  if (m.tercio_ppm_max > c.antes_tercio_ppm_max) fallos.push(`un tercio va a ${m.tercio_ppm_max} palabras/min`);
  return fallos.length ? no('falso_bloqueo', `ANTES: ${fallos.join(', ')}.`) : OK;
}

/** DESPUÉS válido: sin pausas largas y rápido. */
export function checkDespues(m: ClipMeasures, c: VerifyConfig): RuleResult {
  const fallos: string[] = [];
  if (m.pausa_max_s > c.despues_pausa_max_s) fallos.push(`pausa de ${m.pausa_max_s} s (máximo ${c.despues_pausa_max_s})`);
  if (m.ppm < c.despues_ppm_min) fallos.push(`${m.ppm} palabras/min (mínimo ${c.despues_ppm_min})`);
  return fallos.length ? no('sin_contraste', `DESPUÉS poco fluido: ${fallos.join(', ')}.`) : OK;
}

/** Contraste entre los dos clips. Pausas por minuto: el DESPUÉS dura más. */
export function checkContraste(a: ClipMeasures, b: ClipMeasures, c: VerifyConfig): RuleResult {
  const fallos: string[] = [];
  if (b.ppm < c.contraste_ppm_factor * a.ppm) fallos.push(`velocidad ×${(b.ppm / Math.max(1, a.ppm)).toFixed(2)} (mínimo ×${c.contraste_ppm_factor})`);
  if (!(b.pausas_min < c.contraste_pausas_factor * a.pausas_min)) fallos.push(`pausas/min ${b.pausas_min} frente a ${a.pausas_min}`);
  if (!(b.habla_s > a.habla_s)) fallos.push(`el DESPUÉS (${b.habla_s} s) no es más largo que el ANTES (${a.habla_s} s)`);
  return fallos.length ? no('sin_contraste', `Contraste: ${fallos.join(', ')}.`) : OK;
}

/** Semanas enteras entre dos fechas 'YYYY-MM-DD' (negativo si el orden está al revés). */
export function weeksBetween(from: string, to: string): number {
  const d = (Date.parse(`${to.slice(0, 10)}T12:00:00Z`) - Date.parse(`${from.slice(0, 10)}T12:00:00Z`)) / 86_400_000;
  return Number.isFinite(d) ? Math.floor(d / 7) : 0;
}

// ── Imagen (lo que devuelve Claude) ──────────────────────────────────────────

export interface VisionSide {
  camara_alumno: 'encendida' | 'apagada' | 'no_se_ve';
  camara_conf: number;
  pantalla_compartida: boolean;
  recuadros_pequenos: boolean;
  leyendo: boolean;
  leyendo_conf: number;
  /** Nombre del recuadro con el indicador de voz, tal cual se lee ('' si no se lee). */
  nombre_que_habla: string;
  /** Respaldo sin nombre: comparando con la foto del profe. */
  quien_habla_por_cara: 'alumno' | 'profe' | 'no_se_sabe';
}

export interface VisionVerdict {
  antes: VisionSide;
  despues: VisionSide;
  nota: number;
  explicacion: string;
}

/**
 * Reglas de la IMAGEN de un lado. `isStudent` / `isTeacher` dicen si un nombre
 * leído en un recuadro es el del alumno o el del profe (lib/testimonialSpeaker).
 */
export function checkVision(v: VisionSide, lado: 'ANTES' | 'DESPUÉS', c: VerifyConfig,
  isStudent: (name: string) => boolean, isTeacher: (name: string) => boolean): RuleResult {
  const nombre = v.nombre_que_habla.trim();
  const esAlumno = !!nombre && isStudent(nombre), esProfe = !!nombre && isTeacher(nombre);
  if (esProfe && !esAlumno) return no('habla_profe', `${lado}: el recuadro que habla es "${nombre}", el profe.`);
  // Respaldo: sin nombre legible (o uno que no es ninguno de los dos), la foto del profe.
  if (!esAlumno && !esProfe && v.quien_habla_por_cara === 'profe') {
    return no('habla_profe', `${lado}: ${nombre ? `"${nombre}" no es ninguno de los dos` : 'sin nombre legible'}; por la cara, habla el profe.`);
  }
  if (v.camara_alumno === 'apagada' && v.camara_conf >= c.vision_camara_conf) {
    return no('camara_apagada', `${lado}: la cámara del alumno está apagada.`);
  }
  if (v.pantalla_compartida && v.recuadros_pequenos) {
    return no('leyendo', `${lado}: pantalla compartida con los recuadros pequeños.`);
  }
  if (v.leyendo && v.leyendo_conf >= c.vision_leyendo_conf) {
    return no('leyendo', `${lado}: el alumno parece estar leyendo.`);
  }
  return OK;
}

// ── Resúmenes ────────────────────────────────────────────────────────────────

/** "14 en español, 9 habla el profe" (de más a menos). */
export function motivosFrase(cuentas: Partial<Record<string, number>>): string {
  return Object.entries(cuentas)
    .filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${(MOTIVO_LABEL[k as Motivo] ?? k).toLowerCase()}`)
    .join(', ');
}

/**
 * Umbral que se endurece con un motivo, si toca: el motivo aparece `veces` o más
 * en las últimas `ventana` revisiones posteriores al último cambio de ese umbral.
 */
export function shouldHarden(reviews: Array<{ motivo: string | null; at: string }>, motivo: string,
  lastChangeAt: string | null, ventana: number, veces: number): boolean {
  const recientes = [...reviews].sort((a, b) => b.at.localeCompare(a.at)).slice(0, ventana);
  const n = recientes.filter(r => r.motivo === motivo && (!lastChangeAt || r.at > lastChangeAt)).length;
  return n >= veces;
}

/** Valor nuevo de un umbral al endurecerlo un paso, sin pasar del límite. null = ya está en el límite. */
export function hardenedValue(value: number, paso: number, limite: number | null): number | null {
  let next = Math.round((value + paso) * 1000) / 1000;
  if (limite != null) next = paso > 0 ? Math.min(next, limite) : Math.max(next, limite);
  return next === value ? null : next;
}
