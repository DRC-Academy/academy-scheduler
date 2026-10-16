// ── Configuración del SCORING v2 de profesores ───────────────────────────────
//
// Todos los números que deciden el puntaje viven acá, para poder ajustarlos sin
// tocar el motor (lib/teacherScore.ts). Si cambiás algo que altera el resultado
// de forma importante, subí FORMULA_VERSION: las fotos guardadas en
// teacher_score_snapshots quedan marcadas con la versión que las calculó.
//
// El scoring viejo (lib/scoringStore, pestaña Scoring, Mi Scoring, setter) NO lee
// nada de este archivo. Los dos conviven hasta que el v2 se valide.

/** Versión de la fórmula. Va en teacher_score_snapshots.formula_version. */
export const FORMULA_VERSION = 'v2';

/** Ventana de cálculo: los últimos N días (hora de España), hoy incluido. */
export const VENTANA_DIAS = 90;

/**
 * Peso de cada pilar sobre 100. Un pilar sin datos suficientes queda en null y
 * su peso se reparte entre los demás (no cuenta como cero).
 */
export const PESOS = {
  retencion: 40,
  cumplimiento: 30,
  riesgo: 20,
  calidad: 10,
  /** Preparado para más adelante: hoy no suma nada. */
  crecimiento: 0,
} as const;

// ── 1) Retención ──────────────────────────────────────────────────────────────

export const RETENCION = {
  /** Días que valen un "alumno-mes" de exposición. */
  diasPorAlumnoMes: 30,
  /**
   * Suavizado: es como sumarle al profe K alumnos-mes con la tasa de bajas
   * promedio de la academia. Con poca exposición el puntaje se acerca a 60.
   */
  K: 6,
  /** Puntos con 0 bajas. */
  puntosSinBajas: 100,
  /** Puntos con una tasa igual a la de la academia. */
  puntosEnPromedio: 60,
  /** Con esta cantidad de veces la tasa de la academia (o más), 0 puntos. */
  multiploParaCero: 2,
} as const;

// ── 2) Cumplimiento ───────────────────────────────────────────────────────────

export const CUMPLIMIENTO = {
  /** Peso de cada parte dentro del pilar (las que quedan en null se reparten). */
  subpesos: { puntualidad: 35, transcripts: 40, cancelaciones: 15, enlaces: 10 },

  /** Antes de esta fecha la puntualidad de los profes en Argentina se midió mal. */
  puntualidadDesde: '2026-07-24',
  /** Valor de cada ingreso: a tiempo cuenta entero, tarde la mitad, muy tarde nada. */
  valorPuntualidad: { on_time: 1, late: 0.5, very_late: 0 } as Record<string, number>,
  /** Mínimo de clases con ingreso para medir la puntualidad. */
  minClasesPuntualidad: 5,

  /** Mínimo de clases con plazo de 24 h ya juzgado (desde el 22/09/2026). */
  minClasesTranscripts: 5,

  /** Mínimo de clases dadas en la ventana para medir las cancelaciones. */
  minClasesCancelaciones: 10,
  /** Puntos que resta cada cancelación tardía por cada 100 clases dadas. */
  puntosPorCancelacionCada100: 25,

  /** Mínimo de alumnos nuevos (con plazo de enlace) para medir los enlaces. */
  minAlumnosNuevosEnlaces: 1,
} as const;

// ── 3) Gestión del riesgo ─────────────────────────────────────────────────────

export const RIESGO = {
  /** Con menos auditorías de protocolo que esto, el pilar queda en null. */
  minAuditorias: 3,
  /**
   * Suavizado, igual que en retención: es como sumarle al profe K auditorías con
   * el % de intervención promedio de la academia. Con pocas auditorías el
   * puntaje se acerca al promedio.
   */
  K_RIESGO: 5,
} as const;

// ── 4) Calidad ────────────────────────────────────────────────────────────────

export const CALIDAD = {
  /** Peso de cada parte dentro del pilar. */
  subpesos: { senal: 70, habla: 30 },
  /** Mínimo de clases con señal verde/amarilla/roja. */
  minClasesSenal: 5,
  /** Mínimo de clases con el % de habla del alumno. */
  minClasesHabla: 5,
  /** Puntos si la mediana del profe es igual a la de la academia. */
  hablaPuntosEnMediana: 60,
  /** Puntos porcentuales POR ENCIMA de la mediana de la academia que dan 100. */
  hablaPpParaCien: 15,
  /** Puntos porcentuales POR DEBAJO de la mediana de la academia que dan 0. */
  hablaPpParaCero: 22.5,
} as const;

// ── Ajustes manuales (sobre el total) ─────────────────────────────────────────

/**
 * Eventos de scoring_events que el v2 tiene en cuenta, dentro de la ventana. El
 * resto de los eventos manuales viejos se ignora. `maxPorVentana: null` = sin
 * tope. El "Bonus feedback" del formulario viejo hace de FELICITACIÓN.
 */
export const AJUSTES_MANUALES: Record<string, { etiqueta: string; puntos: number; maxPorVentana: number | null }> = {
  queja:          { etiqueta: 'Queja',        puntos: -10, maxPorVentana: null },
  bonus_feedback: { etiqueta: 'Felicitación', puntos: 5,   maxPorVentana: 1 },
};

// ── Confianza y nivel ─────────────────────────────────────────────────────────

export const CONFIANZA = {
  /** Alta: al menos esta exposición Y estas clases en la ventana. */
  alta: { alumnosMes: 12, clases: 30 },
  /** Media: al menos esta exposición. Por debajo, baja. */
  media: { alumnosMes: 4 },
} as const;

export const NIVELES = {
  /** Con menos días dando clases, "En evaluación" sin importar el puntaje. */
  diasMinimos: 90,
  /** Top pide además confianza ALTA; con confianza media, un puntaje de Top queda en Destacado. */
  top: 85,
  destacado: 75,
  estandar: 60,
  // Por debajo de `estandar`: "En revisión". Es SOLO una marca para el admin:
  // no bloquea nada en ningún lado.
} as const;

/** Tope de eventos que se listan por métrica en el detalle (el resto se resume). */
export const MAX_EVENTOS_DETALLE = 15;
