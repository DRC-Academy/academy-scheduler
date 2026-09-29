// Estado del FORMULARIO inicial y de la PRUEBA DE NIVEL de un alumno, con el
// historial de los "Regenerar todo" anteriores. SOLO SERVIDOR.
//
// Lo usan la confirmación de "Regenerar todo" (qué hizo ya el alumno) y la
// tarjeta de la ficha (estado actual + historial desplegable). Vigente = sin
// `superseded_at`; lo que tiene esa marca es historial (lib/levelTest/canonical).
//
// Búsqueda: por student_id y, además, por nombre (tokens y sesiones viejos sin
// id), el mismo criterio tolerante que el resto del sistema.

import type { SupabaseClient } from '@supabase/supabase-js';
import { pickCanonical, isSuperseded } from '@/lib/levelTest/canonical';

export type FormStatus = 'none' | 'pending' | 'completed' | 'expired';
export type TestStatus = 'none' | 'pending' | 'in_progress' | 'completed';

export interface FormSnapshot {
  state: FormStatus;
  completedAt: string | null;
  createdAt: string | null;
}

export interface TestSnapshot {
  state: TestStatus;
  answered: number;
  completedAt: string | null;
  cefr: string | null;
  score: number | null;
  /** Nivel que había confirmado el profe sobre esta prueba (solo en el historial). */
  teacherLevel?: string | null;
}

export interface HistoryEntry {
  /** Cuándo se regeneró (lo que quedó como historial en ese momento). */
  supersededAt: string;
  forms: FormSnapshot[];
  tests: TestSnapshot[];
}

export interface OnboardingStatus {
  form: FormSnapshot;
  test: TestSnapshot;
  history: HistoryEntry[];
}

interface TokenRow {
  id: string; token: string; status: string | null; created_at: string;
  completed_at: string | null; expires_at: string | null; superseded_at: string | null;
}
interface SessionRow {
  id: string; token: string; status: string; created_at: string; completed_at: string | null;
  expires_at: string | null; student_id: string | null; teacher_id: string | null;
  cefr_level: string | null; overall_score: number | null; superseded_at: string | null;
  ai_evaluation: { teacher_confirmation?: { level?: string | null } } | null;
  level_test_answers?: Array<{ count: number }>;
}

const TOKEN_COLS = 'id, token, status, created_at, completed_at, expires_at, superseded_at';
const SESSION_COLS =
  'id, token, status, created_at, completed_at, expires_at, student_id, teacher_id, ' +
  'cefr_level, overall_score, superseded_at, ai_evaluation, level_test_answers(count)';

/** Filas por student_id y por nombre, sin repetir. */
async function loadBoth<T extends { id: string }>(
  client: SupabaseClient, table: string, cols: string, student: { id?: string | null; name: string },
): Promise<T[]> {
  const out = new Map<string, T>();
  if (student.id) {
    const { data, error } = await client.from(table).select(cols).eq('student_id', student.id);
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const r of (data ?? []) as unknown as T[]) out.set(r.id, r);
  }
  const name = student.name.trim();
  if (name) {
    const { data, error } = await client.from(table).select(cols).ilike('student_name', name);
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const r of (data ?? []) as unknown as T[]) out.set(r.id, r);
  }
  return [...out.values()];
}

function formOf(t: TokenRow | undefined, now: number): FormSnapshot {
  if (!t) return { state: 'none', completedAt: null, createdAt: null };
  const caducado = t.expires_at ? new Date(t.expires_at).getTime() < now : false;
  const state: FormStatus = t.status === 'completed' ? 'completed'
    : t.status === 'expired' || caducado ? 'expired' : 'pending';
  return { state, completedAt: t.completed_at, createdAt: t.created_at };
}

function testOf(s: SessionRow | undefined): TestSnapshot {
  if (!s) return { state: 'none', answered: 0, completedAt: null, cefr: null, score: null };
  const answered = s.level_test_answers?.[0]?.count ?? 0;
  const state: TestStatus = s.status === 'completed' ? 'completed'
    : answered > 0 || s.status === 'in_progress' ? 'in_progress' : 'pending';
  return {
    state, answered, completedAt: s.completed_at, cefr: s.cefr_level, score: s.overall_score,
    teacherLevel: s.ai_evaluation?.teacher_confirmation?.level ?? null,
  };
}

export async function loadOnboardingStatus(
  client: SupabaseClient, student: { id?: string | null; name: string }, now: number = Date.now(),
): Promise<OnboardingStatus> {
  const [tokens, sessions] = await Promise.all([
    loadBoth<TokenRow>(client, 'form_tokens', TOKEN_COLS, student),
    loadBoth<SessionRow>(client, 'level_test_sessions', SESSION_COLS, student),
  ]);
  const byNew = <T extends { created_at: string }>(a: T, b: T) => b.created_at.localeCompare(a.created_at);

  // Vigente: el formulario más reciente sin marca; la prueba, la principal.
  const liveTokens = tokens.filter(t => !isSuperseded(t)).sort(byNew);
  const liveSessions = sessions.filter(s => !isSuperseded(s));
  const principal = pickCanonical(liveSessions.map(s => ({
    token: s.token, status: s.status, expires_at: s.expires_at, created_at: s.created_at,
    student_id: s.student_id, teacher_id: s.teacher_id, answered: s.level_test_answers?.[0]?.count ?? 0,
  })), now);
  const currentSession = principal.kind === 'none' ? undefined : liveSessions.find(s => s.token === principal.token);

  // Historial: agrupado por el momento del regenerado. Solo lo que tuvo algo
  // (un formulario completado o una prueba con respuestas): los enlaces que
  // nadie abrió no aportan nada.
  const grupos = new Map<string, HistoryEntry>();
  const grupo = (at: string) => grupos.get(at) ?? grupos.set(at, { supersededAt: at, forms: [], tests: [] }).get(at)!;
  for (const t of tokens.filter(isSuperseded).sort(byNew)) {
    if (t.status === 'completed') grupo(t.superseded_at!).forms.push(formOf(t, now));
  }
  for (const s of sessions.filter(isSuperseded).sort(byNew)) {
    const snap = testOf(s);
    if (snap.state === 'completed' || snap.answered > 0) grupo(s.superseded_at!).tests.push(snap);
  }

  return {
    form: formOf(liveTokens[0], now),
    test: testOf(currentSession),
    history: [...grupos.values()].sort((a, b) => b.supersededAt.localeCompare(a.supersededAt)),
  };
}
