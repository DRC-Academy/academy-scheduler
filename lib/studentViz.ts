// Derivaciones para las visualizaciones de la ficha del alumno.
//
// REGLA: todo sale de datos reales. Cuando un dato no existe se devuelve null y
// la UI muestra "sin datos" — nunca una cifra inventada.
//
// Qué hay y qué no:
//   · progress_score (1-10)          → sí, lo escribe analyze-transcript.
//   · nivel CEFR                     → sí (current_level / studentLevel).
//   · clases dadas                   → sí (calcCurrentClassNumber / class_number).
//   · destrezas por separado         → SOLO la autoevaluación del formulario
//                                      inicial (q6_nivel). Es una foto del día 1,
//                                      no una evolución: rotularla como tal.
//   · % de avance al siguiente nivel → NO existe.
//   · total de clases del plan       → NO existe (se usa el próximo hito real).
//   · "constancia"                   → NO existe.

import { SKILL_LEVELS, questionsForResponses, skillsQuestionOf } from '@/lib/formQuestions';
import { getNextMilestone } from '@/lib/milestones';

// ── Autoevaluación por destreza (matriz del formulario inicial) ──────────────
// Antes acá estaba escrito a mano el id del formulario general ('q6_nivel'), así
// que el gráfico quedaba vacío para cualquier otra variante. Ahora la matriz se
// busca en el formulario que el alumno contestó de verdad.
export const SKILL_QUESTION_ID = 'q6_nivel';   // solo compatibilidad; no se usa para leer

export interface SkillGauge {
  label: string;        // "Hablar"
  levelLabel: string;   // "Intermedio"
  pct: number;          // 20 · 40 · 60 · 80 · 100
}

/**
 * Lee la matriz de autoevaluación del formulario. Devuelve null si el alumno
 * todavía no completó el formulario o la pregunta no está respondida.
 */
export function skillsFromResponses(
  responses: Record<string, unknown> | null | undefined,
): SkillGauge[] | null {
  const matrix = skillsQuestionOf(questionsForResponses(responses));
  const raw = matrix ? responses?.[matrix.id] : undefined;
  if (!raw || typeof raw !== 'object') return null;

  const answers = raw as Record<string, string>;
  const out: SkillGauge[] = [];
  for (const [label, value] of Object.entries(answers)) {
    const idx = (SKILL_LEVELS as readonly string[]).indexOf((value ?? '').trim());
    if (idx < 0) continue;                       // sin responder o valor desconocido
    out.push({ label, levelLabel: SKILL_LEVELS[idx], pct: ((idx + 1) / SKILL_LEVELS.length) * 100 });
  }
  return out.length > 0 ? out : null;
}

// ── Escalera CEFR ────────────────────────────────────────────────────────────
export const CEFR_LADDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
export type CefrStepState = 'done' | 'current' | 'todo';

/** Normaliza "b1", "Nivel B1", "B1 exámenes" → "B1". Null si no se reconoce. */
export function parseCefr(raw: string | null | undefined): string | null {
  const m = (raw ?? '').toUpperCase().match(/\b(A1|A2|B1|B2|C1|C2)\b/);
  return m ? m[1] : null;
}

export function cefrSteps(raw: string | null | undefined): Array<{ label: string; state: CefrStepState }> {
  const level = parseCefr(raw);
  const at = level ? CEFR_LADDER.indexOf(level as typeof CEFR_LADDER[number]) : -1;
  return CEFR_LADDER.map((label, i) => ({
    label,
    state: at < 0 ? 'todo' : i < at ? 'done' : i === at ? 'current' : 'todo',
  }));
}

// ── Progreso hacia el próximo hito real (1 · 15 · 30 · 50) ───────────────────
export interface MilestoneProgress {
  current: number;
  target: number;
  pct: number;
}

/** Null cuando ya se pasaron todos los hitos definidos. */
export function milestoneProgress(classNumber: number): MilestoneProgress | null {
  const target = getNextMilestone(classNumber);
  if (!target) return null;
  return { current: classNumber, target, pct: Math.min(100, (classNumber / target) * 100) };
}

// ── Estructura de la clase generada (barra de tiempo) ─────────────────────────
export interface ClassSegment {
  key: string;
  title: string;
  minutes: number;
  pct: number;
  color: string;
}

const SEGMENT_COLORS = ['#16a34a', '#0f766e', '#2563eb', '#7c3aed'];

/** "15 minutos" · "15 min" · "15" → 15. Null si no hay número. */
export function parseMinutes(text: string | null | undefined): number | null {
  const m = (text ?? '').match(/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Convierte los 4 bloques de una clase de metodología aplicada en segmentos con
 * ancho proporcional. Si algún bloque no declara minutos usables, devuelve null
 * (mejor no pintar la barra que pintarla con proporciones inventadas).
 */
export function classSegments(
  blocks: Array<{ key: string; title: string; duration: string }>,
): ClassSegment[] | null {
  const parsed = blocks.map(b => ({ ...b, minutes: parseMinutes(b.duration) }));
  if (parsed.some(b => b.minutes == null)) return null;

  const total = parsed.reduce((s, b) => s + (b.minutes ?? 0), 0);
  if (total <= 0) return null;

  return parsed.map((b, i) => ({
    key: b.key,
    title: b.title,
    minutes: b.minutes!,
    pct: (b.minutes! / total) * 100,
    color: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
  }));
}
