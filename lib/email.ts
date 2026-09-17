// Normalización de emails. Una sola regla para todo el proyecto, cliente y
// servidor: minúsculas y sin espacios alrededor.
//
// Vivía como función privada de lib/useSubscriptionStatus ('use client') y por
// eso lib/progresoSignature la tenía duplicada en una línea. Ahora las dos la
// importan de acá, igual que el follow-up de la prueba de nivel, que la necesita
// para comparar students.email con assignments.student_email: hay alumnos con
// las dos distintas y sin normalizar se mandaba el correo dos veces o a ninguna.

export function normEmail(email?: string | null): string {
  return (email ?? '').trim().toLowerCase();
}

/**
 * Email principal y alternativo de un alumno.
 *
 *   · `to`  → students.email (el que está en WooCommerce), normalizado. Si el
 *             alumno no tiene, el de la assignment; si tampoco, el del token.
 *   · `alt` → el de la assignment cuando es DISTINTO del principal. Se guarda
 *             junto al envío para poder revisarlo; no se le escribe.
 */
export function resolveStudentEmails(args: {
  studentEmail?: string | null;
  assignmentEmail?: string | null;
  tokenEmail?: string | null;
}): { to: string; alt: string | null } {
  const student = normEmail(args.studentEmail);
  const assignment = normEmail(args.assignmentEmail);
  const token = normEmail(args.tokenEmail);
  const to = student || assignment || token;
  const candidates = [assignment, token].filter(e => e && e !== to);
  return { to, alt: candidates[0] ?? null };
}
