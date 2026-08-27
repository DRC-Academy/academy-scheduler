// FUENTE ÚNICA del nivel CEFR de un alumno.
//
// Hay cuatro campos de nivel repartidos por la base, escritos por cuatro cosas
// distintas y en cuatro momentos distintos. Antes cada pantalla elegía por su
// cuenta cuál mirar, y elegían distinto: la ficha del profesor pintaba la
// escalera con `current_level ‖ assignment.student_level`, la página de progreso
// del alumno usaba `current_level ‖ level_test_cefr ‖ assignment.student_level`,
// y la generación de clases con IA solo miraba `assignment.student_level` — o
// sea que la prueba de nivel no llegaba nunca al prompt. Tres respuestas para la
// misma pregunta.
//
// Esta es la única implementación de la regla. Todo el que necesite "el nivel
// del alumno" llama acá.
//
// PRIORIDAD (gana el primero que sea un CEFR reconocible):
//
//   1. teacher_confirmed_level  El profesor, tras las primeras clases. Manda.
//   2. current_level            Columna histórica de la ficha. Ver nota abajo.
//   3. level_test_cefr          La prueba de nivel automática.
//   4. assignment.student_level Lo que tipeó el setter al dar de alta al alumno.
//
// Sobre `current_level`: está en el orden por fidelidad a lo que hacía la app,
// pero HOY no la escribe ningún código (verificado en agosto/2026; los
// `current_level:` de lib/db.ts son de la tabla `teachers`, el nivel 1/2/3 de
// gamificación del profesor, otra cosa). Siempre es NULL, así que en la práctica
// no compite con nadie. Se deja porque quitarla sería cambiar comportamiento
// para arreglar algo que no está roto.
//
// Por qué "el primero que PARSEE" y no "el primero que no esté vacío": los
// campos de nivel son texto libre y en producción `assignment.student_level`
// dice cosas como "Inglés general" o "B1 Exámenes". Un campo relleno pero sin
// CEFR dentro no es un nivel: si ganara por estar relleno, taparía a uno
// posterior que sí lo tiene.

import { parseCefr } from '@/lib/studentViz';

/** De dónde salió el nivel que se está mostrando. */
export type LevelOrigin = 'profesor' | 'ficha' | 'prueba' | 'alta';

export const LEVEL_ORIGIN_LABEL: Record<LevelOrigin, string> = {
  profesor: 'confirmado por el profesor',
  ficha:    'de la ficha',
  prueba:   'de la prueba de nivel',
  alta:     'del alta del alumno',
};

export interface LevelSources {
  /** student_profiles.teacher_confirmed_level */
  teacherConfirmed?: string | null;
  /** student_profiles.current_level */
  fichaLevel?: string | null;
  /** student_profiles.level_test_cefr */
  testLevel?: string | null;
  /** assignments.student_level */
  assignmentLevel?: string | null;
}

export interface EffectiveLevel {
  /** CEFR normalizado ("B1") o null si ninguna fuente contiene uno. */
  level: string | null;
  /** El texto tal cual estaba guardado ("B1 Exámenes"). Para mostrar y para
   *  pasárselo a quien ya parsea por su cuenta (buildEstimate, cefrSteps). */
  raw: string | null;
  origin: LevelOrigin | null;
  /** true si el profesor se pronunció Y su nivel difiere del de la prueba. */
  correctedByTeacher: boolean;
}

const ORDER: Array<[LevelOrigin, keyof LevelSources]> = [
  ['profesor', 'teacherConfirmed'],
  ['ficha',    'fichaLevel'],
  ['prueba',   'testLevel'],
  ['alta',     'assignmentLevel'],
];

const clean = (v: string | null | undefined): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || null;
};

/** La regla. Un solo sitio, para que ninguna pantalla se desincronice. */
export function getEffectiveLevel(src: LevelSources): EffectiveLevel {
  const confirmed = parseCefr(src.teacherConfirmed);
  const test = parseCefr(src.testLevel);
  const correctedByTeacher = !!confirmed && !!test && confirmed !== test;

  // Primera pasada: el primero que contenga un CEFR de verdad.
  for (const [origin, key] of ORDER) {
    const raw = clean(src[key]);
    const level = parseCefr(raw);
    if (level) return { level, raw, origin, correctedByTeacher };
  }

  // Ninguna fuente trae un CEFR. Se devuelve igualmente el primer texto no vacío
  // para que la ficha siga mostrando lo que muestra hoy ("Inglés general") en
  // vez de un guion, pero con `level: null` para que quien necesite un CEFR de
  // verdad (el prompt de la IA, la escalera) sepa que no lo hay.
  for (const [origin, key] of ORDER) {
    const raw = clean(src[key]);
    if (raw) return { level: null, raw, origin, correctedByTeacher };
  }

  return { level: null, raw: null, origin: null, correctedByTeacher };
}

/** Lo que traen las pantallas: una ficha (puede no existir) y una assignment. */
export interface ProfileLevelFields {
  teacher_confirmed_level?: string | null;
  current_level?: string | null;
  level_test_cefr?: string | null;
}

/**
 * Atajo para el caso normal: ficha + nivel del alta. Todas las pantallas del
 * profesor y la del alumno pasan por acá.
 */
export function effectiveLevelOf(
  profile: ProfileLevelFields | null | undefined,
  assignmentLevel: string | null | undefined,
): EffectiveLevel {
  return getEffectiveLevel({
    teacherConfirmed: profile?.teacher_confirmed_level,
    fichaLevel:       profile?.current_level,
    testLevel:        profile?.level_test_cefr,
    assignmentLevel,
  });
}

/**
 * El nivel de REFERENCIA que se le enseña al profesor junto al desplegable: lo
 * que había ANTES de que él opinara. Sin esto, el control mostraría su propia
 * respuesta como si fuera el dato de partida.
 */
export function referenceLevelOf(
  profile: ProfileLevelFields | null | undefined,
  assignmentLevel: string | null | undefined,
): EffectiveLevel {
  return getEffectiveLevel({
    fichaLevel:       profile?.current_level,
    testLevel:        profile?.level_test_cefr,
    assignmentLevel,
  });
}

// ── Qué hizo el profesor con el nivel ────────────────────────────────────────
//
// TRES estados, y hay que poder distinguirlos: la pareja (nivel de la prueba /
// nivel del profesor) es el set de calibración, y solo sirve para medir si la
// prueba acierta si recoge TAMBIÉN los acuerdos.
//
// El campo vacío decía dos cosas a la vez —"estoy de acuerdo" y "ni lo miré"— y
// eso dejaba el set con solo desacuerdos. En agosto de 2026: 15 alumnos con
// prueba, 2 con nivel del profesor, y los DOS eran correcciones. Con eso la
// prueba parece fallar el 100% de las veces, cuando lo único que sabíamos es que
// el profesor solo tocaba el control cuando algo le chirriaba.

export type TeacherReviewState =
  | 'sin_revisar'   // el profesor todavía no se pronunció
  | 'confirmado'    // miró y puso el MISMO nivel que la referencia
  | 'corregido';    // puso otro, o no había referencia y lo definió él

export const REVIEW_STATE_LABEL: Record<TeacherReviewState, string> = {
  sin_revisar: 'Sin revisar',
  confirmado:  'Confirmado por el profesor',
  corregido:   'Corregido por el profesor',
};

export interface TeacherReview {
  state: TeacherReviewState;
  /** Lo que puso el profesor. null si no se pronunció. */
  level: string | null;
  /**
   * Contra qué comparó. Se prefiere `teacher_confirmed_against` —el nivel de
   * referencia CONGELADO al confirmar— sobre el actual: si mañana se repite la
   * prueba y da otro nivel, un acuerdo de hoy no puede pasar a leerse como
   * desacuerdo. Cuando la columna todavía no existe se cae al de la prueba.
   */
  against: string | null;
  at: string | null;
  by: string | null;
  /**
   * ¿Entra en el set de calibración? Solo si el profesor se pronunció Y había un
   * nivel de PRUEBA con el que comparar. Un alumno al que el profesor le puso el
   * nivel de la nada no dice nada sobre si la prueba acierta.
   */
  comparable: boolean;
}

export interface TeacherReviewFields extends ProfileLevelFields {
  teacher_confirmed_at?: string | null;
  teacher_confirmed_by?: string | null;
  /** Nivel de referencia en el momento de confirmar (supabase-teacher-level-against.sql). */
  teacher_confirmed_against?: string | null;
}

/**
 * Qué hizo el profesor con el nivel de este alumno. Una sola definición: la
 * consumen la ficha, el panel de admin y cualquier consulta de calibración.
 */
export function teacherReviewOf(
  profile: TeacherReviewFields | null | undefined,
  assignmentLevel: string | null | undefined,
): TeacherReview {
  const level = parseCefr(profile?.teacher_confirmed_level);
  const congelado = parseCefr(profile?.teacher_confirmed_against);
  const prueba = parseCefr(profile?.level_test_cefr);
  const referencia = congelado ?? referenceLevelOf(profile, assignmentLevel).level;

  const at = clean(profile?.teacher_confirmed_at);
  const by = clean(profile?.teacher_confirmed_by);

  if (!level) {
    return { state: 'sin_revisar', level: null, against: referencia, at: null, by: null, comparable: false };
  }
  return {
    state: referencia && level === referencia ? 'confirmado' : 'corregido',
    level,
    against: referencia,
    at, by,
    // Con `teacher_confirmed_against` guardado vale ese; si no, hace falta que la
    // prueba exista HOY para poder llamar a esto una comparación.
    comparable: !!(congelado ?? prueba),
  };
}
