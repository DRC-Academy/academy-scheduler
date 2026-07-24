// ── Formulario inicial del alumno: registro de variantes ─────────────────────
//
// Hay una variante por tipo de plan. El general es el que reciben los alumnos de
// inglés general e intensivo; cada examen puede tener el suyo.
//
// PARA AGREGAR UN FORMULARIO NUEVO hacen falta exactamente dos cosas:
//   1. un archivo `lib/formQuestions/<examen>.ts` que exporte un FormQuestion[]
//   2. una entrada en FORM_VARIANTS (abajo), con su `match`
// Nada más: la página pública, la validación, el formateo para la IA, la ficha
// del profesor y el gráfico de destrezas salen todos del registro.
//
// Los `id` de pregunta deben ser ÚNICOS EN TODO EL PROYECTO (no solo dentro de su
// formulario): las respuestas se guardan en un JSON plano `{ [id]: valor }` y de
// ahí se deduce qué formulario contestó un alumno (ver questionsForResponses).

import { classifyPlan, detectLevel } from '@/lib/productUtils';
import { FormQuestion, FormResponses } from './types';
import { FORM_GENERAL } from './general';
import { FORM_B1_PRELIMINARY } from './b1Preliminary';

export type { FormQuestion, QuestionType, FormResponses } from './types';
export { SKILL_LEVELS } from './types';
export { FORM_GENERAL } from './general';
export { FORM_B1_PRELIMINARY } from './b1Preliminary';

export type FormVariant = 'general' | 'b1_preliminary';

interface VariantDef {
  id: FormVariant;
  label: string;              // para la UI del profe/admin
  questions: FormQuestion[];
  /**
   * ¿Le corresponde esta variante a un alumno con este plan? Se evalúan en orden
   * y gana la primera que devuelva true; 'general' es el fallback y no se evalúa.
   */
  match?: (ctx: { isExamen: boolean; level: string | null }) => boolean;
}

export const FORM_VARIANTS: VariantDef[] = [
  {
    id: 'b1_preliminary',
    label: 'B1 Preliminary',
    questions: FORM_B1_PRELIMINARY,
    match: ({ isExamen, level }) => isExamen && level === 'B1',
  },
  // ← Próximos: B2 First, C1 Advanced, IELTS. Un archivo + una entrada acá.
  {
    id: 'general',
    label: 'Inglés general',
    questions: FORM_GENERAL,
  },
];

const byId = new Map<FormVariant, VariantDef>(FORM_VARIANTS.map(v => [v.id, v]));

/** Preguntas de una variante. Cae al general si el id no existe. */
export function questionsOf(variant: FormVariant | null | undefined): FormQuestion[] {
  return (variant && byId.get(variant)?.questions) || FORM_GENERAL;
}

export function labelOf(variant: FormVariant | null | undefined): string {
  return (variant && byId.get(variant)?.label) || 'Inglés general';
}

/**
 * Qué formulario le toca a un alumno, a partir de su plan.
 *
 * Reutiliza classifyPlan (única fuente de "esto es un examen") y detectLevel
 * (única fuente del nivel), así que un plan como "Curso de inglés general - 2h,
 * B1" NO cae en el formulario de B1: es general aunque mencione el nivel.
 *
 * IMPORTANTE — el nivel se deduce del TEXTO DEL PLAN, nunca del campo
 * `student_level` de la assignment. En producción ese campo dice "B1" en 44
 * alumnos, muchos de los cuales preparan B2, FCE o IELTS: usarlo les mandaría el
 * formulario del examen equivocado. El texto del plan es lo único que identifica
 * de verdad QUÉ examen prepara el alumno.
 *
 * Criterio conservador: si el plan no identifica el examen (p. ej. "Preparación
 * del examen IELTS", sin nivel), va el general — que le sirve a cualquiera. Un
 * formulario de otro examen sería peor que el genérico.
 *
 * Un examen sin formulario propio todavía —B2, C1, IELTS— recibe el general.
 * Cuando se agregue el suyo al registro, empieza a usarlo sin tocar nada más.
 */
export function resolveFormVariant(fields: {
  plan?: string | null;
  objetivo?: string | null;
  studentPlan?: string | null;
  productName?: string | null;
}): FormVariant {
  const isExamen = classifyPlan({
    assignmentPlan:     fields.plan,
    assignmentObjetivo: fields.objetivo,
    studentPlan:        fields.studentPlan,
    productName:        fields.productName,
  }).type === 'examenes';

  // detectLevel respeta la prioridad C2 > C1 > B2 > B1, así que "B2 First
  // Certificate" resuelve B2 y no matchea el formulario de B1.
  const level = detectLevel(
    [fields.plan, fields.productName, fields.studentPlan, fields.objetivo].filter(Boolean).join(' '),
  );

  for (const v of FORM_VARIANTS) {
    if (v.match?.({ isExamen, level })) return v.id;
  }
  return 'general';
}

/**
 * Qué preguntas corresponden a unas respuestas YA GUARDADAS.
 *
 * Se prefiere deducirlo de los ids presentes en vez de reclasificar el plan: es
 * lo que el alumno contestó de verdad, y así una ficha vieja se sigue mostrando
 * bien aunque el plan del alumno cambie después o cambien las reglas de
 * resolveFormVariant. `hint` (la variante esperada) solo desempata.
 */
export function questionsForResponses(
  responses: FormResponses | null | undefined,
  hint?: FormVariant | null,
): FormQuestion[] {
  const ids = new Set(Object.keys(responses ?? {}));
  if (ids.size === 0) return questionsOf(hint);

  let best: VariantDef | null = null;
  let bestHits = 0;
  for (const v of FORM_VARIANTS) {
    const hits = v.questions.reduce((n, q) => n + (ids.has(q.id) ? 1 : 0), 0);
    if (hits > bestHits || (hits === bestHits && hits > 0 && v.id === hint)) {
      best = v; bestHits = hits;
    }
  }
  return bestHits > 0 ? best!.questions : questionsOf(hint);
}

/**
 * Pregunta de autoevaluación por destreza (la matriz) de una variante. La usa
 * lib/studentViz para el gráfico de destrezas, que antes tenía el id del
 * formulario general escrito a mano y quedaba vacío con cualquier otro.
 */
export function skillsQuestionOf(questions: FormQuestion[]): FormQuestion | null {
  return questions.find(q => q.type === 'matrix') ?? null;
}

// ── Helpers de respuestas ────────────────────────────────────────────────────

/** Convierte la respuesta cruda de una pregunta a texto legible. */
export function answerToText(q: FormQuestion, value: unknown): string {
  if (value == null || value === '') return '(sin responder)';
  if (q.type === 'checkbox' && Array.isArray(value)) {
    return value.length ? value.join(', ') : '(sin responder)';
  }
  if (q.type === 'matrix' && typeof value === 'object') {
    const v = value as Record<string, string>;
    return (q.rows ?? [])
      .map(row => `${row}: ${v[row]?.trim() ? v[row] : '(sin responder)'}`)
      .join(' · ');
  }
  return String(value);
}

/**
 * Texto legible con preguntas y respuestas, para la IA que genera la ficha (y
 * como respaldo humano). Sin `questions` deduce el formulario de las respuestas.
 */
export function formatResponsesForAI(responses: FormResponses, questions?: FormQuestion[]): string {
  return (questions ?? questionsForResponses(responses))
    .map(q => `${q.title}\n→ ${answerToText(q, responses[q.id])}`)
    .join('\n\n');
}

/** Primera obligatoria sin responder, o null. */
export function firstUnansweredRequired(
  responses: FormResponses,
  questions?: FormQuestion[],
): FormQuestion | null {
  for (const q of (questions ?? questionsForResponses(responses))) {
    if (!q.required) continue;
    const v = responses[q.id];
    if (q.type === 'checkbox') {
      if (!Array.isArray(v) || v.length === 0) return q;
    } else if (q.type === 'matrix') {
      const obj = (v ?? {}) as Record<string, string>;
      if ((q.rows ?? []).some(row => !obj[row])) return q;
    } else if (v == null || String(v).trim() === '') {
      return q;
    }
  }
  return null;
}
