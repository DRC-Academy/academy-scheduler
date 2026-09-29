// Regla ÚNICA de caducidad y de "cuál es la prueba de este alumno". PURO: sin
// base ni red, para usarlo igual en las rutas, en el formulario, en los
// recordatorios y en el admin.
//
// Desde el 28/09/2026:
//   · La prueba de un ALUMNO (sesión con student_id) NO caduca por fecha. Lo que
//     decide si puede hacerla es que siga activo (lib/levelTest/studentAccess),
//     y eso se mira al abrir el enlace. Sus marcas antiguas 'expired' y
//     'abandoned' no son definitivas: al abrirla, se reabre donde se quedó (las
//     respuestas nunca se borraron).
//   · La de un LEAD ("Generar link" del admin) sí caduca por fecha: ahí no hay
//     suscripción que mirar.
//
// Qué es "de un alumno" (29/09/2026): tiene student_id O teacher_id. Las pruebas
// que nacen del formulario, de la bienvenida o de los recordatorios llevan
// siempre el profe; las del admin, nunca. Antes solo contaba student_id, y la
// prueba de un alumno vinculado solo por NOMBRE (formulario sin student_id)
// caducaba a los 30 días como la de un lead. No se mira student_name: el admin
// también lo rellena al generar el enlace de un lead.
//
// Un alumno puede tener varias pruebas (los recordatorios creaban una nueva cada
// vez que la anterior caducaba). La PRINCIPAL es la terminada si la hay; si no,
// la que tiene más respuestas y, a igualdad, la más reciente. Cualquier enlace
// antiguo del alumno lleva a ella, para no perder progreso ni duplicar.

export interface SessionSummary {
  token: string;
  status: string;
  expires_at: string | null;
  created_at: string;
  student_id?: string | null;
  teacher_id?: string | null;
  answered: number;
}

/** ¿Es la prueba de un alumno (y no la de un lead)? Ver arriba. */
export function isStudentSession(s: { student_id?: string | null; teacher_id?: string | null }): boolean {
  return !!(s.student_id || s.teacher_id);
}

/** ¿Caducó esta prueba? Solo las de leads caducan; las de alumnos, nunca. */
export function sessionExpired(
  s: { student_id?: string | null; teacher_id?: string | null; status?: string | null; expires_at?: string | null },
  now: number = Date.now(),
): boolean {
  if (isStudentSession(s)) return false;
  if (s.status === 'expired' || s.status === 'abandoned') return true;
  return !!s.expires_at && new Date(s.expires_at).getTime() < now;
}

export type Canonical =
  | { kind: 'completed'; token: string }
  | { kind: 'open'; token: string; answered: number }
  | { kind: 'none' };

/** La prueba principal de un conjunto de sesiones del MISMO alumno. */
export function pickCanonical(sessions: SessionSummary[], now: number = Date.now()): Canonical {
  const recientes = [...sessions].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const terminada = recientes.find(s => s.status === 'completed');
  if (terminada) return { kind: 'completed', token: terminada.token };
  const abierta = recientes
    .filter(s => !sessionExpired(s, now))
    // sort es estable: a igualdad de respuestas queda la más reciente.
    .sort((a, b) => b.answered - a.answered)[0];
  if (abierta) return { kind: 'open', token: abierta.token, answered: abierta.answered };
  return { kind: 'none' };
}
