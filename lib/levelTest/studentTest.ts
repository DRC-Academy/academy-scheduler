// En qué punto está la prueba de nivel de un alumno, visto desde el FORMULARIO
// inicial: la pantalla final (al enviar o al reabrir un enlace ya completado)
// ofrece empezar o continuar la prueba, o dice que ya está todo hecho.
//
// Regla (la de lib/levelTest/canonical, compartida con recordatorios y rutas):
//   · si el alumno tiene ALGUNA prueba terminada → 'completed' (sin botón);
//   · si no, su prueba principal abierta → 'ready' (con started = ya contestó
//     alguna pregunta, para decir "Continuar" en vez de "Empezar");
//   · si no tiene ninguna → se crea una nueva en ese momento, para que el botón
//     lleve siempre a algún sitio.

import { createTestSession, loadStudentSessions, type TestSessionInput } from './createSession';
import { pickCanonical, type SessionSummary } from './canonical';
import { canTakeLevelTest } from './studentAccess';

export type { SessionSummary } from './canonical';

export type StudentTestState =
  | { kind: 'completed' }
  | { kind: 'ready'; token: string; started: boolean }
  | { kind: 'none' };   // no tiene ninguna: hay que crear una

/** Decisión pura sobre las sesiones del alumno (cualquier orden). */
export function decideStudentTest(sessions: SessionSummary[], now: number = Date.now()): StudentTestState {
  const p = pickCanonical(sessions, now);
  if (p.kind === 'completed') return { kind: 'completed' };
  if (p.kind === 'open') return { kind: 'ready', token: p.token, started: p.answered > 0 };
  return { kind: 'none' };
}

export type ResolvedStudentTest =
  | { kind: 'completed' }
  | { kind: 'ready'; token: string; started: boolean }
  | { kind: 'unavailable' };   // no puede hacerla (lib/levelTest/studentAccess)

/**
 * Estado de la prueba del alumno, creando una sesión nueva si no tiene ninguna.
 * Lanza si la base falla: el llamador decide qué mostrar.
 *
 * Antes de ofrecer una prueba sin terminar se pasa por la MISMA regla que usa
 * el enlace al abrirse (canTakeLevelTest): el formulario nunca ofrece una
 * prueba que luego se vaya a rechazar. Una terminada se enseña siempre.
 */
export async function resolveStudentTest(input: TestSessionInput): Promise<ResolvedStudentTest> {
  const state = decideStudentTest(await loadStudentSessions(input));
  if (state.kind === 'completed') return state;
  // Solo las pruebas con student_id pasan por la regla al abrirse; sin él, la
  // sesión es como la de un lead y el enlace no pregunta.
  if (input.studentId && !(await canTakeLevelTest(input.studentId)).allowed) {
    return { kind: 'unavailable' };
  }
  if (state.kind === 'ready') return state;
  const created = await createTestSession(input);
  if (!created.token) throw new Error(created.error || 'No se pudo crear la prueba de nivel.');
  return { kind: 'ready', token: created.token, started: false };
}
