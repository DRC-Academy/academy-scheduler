// "Cancelar clase" del sistema VIEJO (Bloque 4.4) — RETIRADO (oct/2026).
//
// Era el aviso por email al alumno del botón viejo, que además ponía −5 € al
// instante desde el navegador. Desde el sistema único de penalizaciones
// (lib/teacherPenalties) el profesor cancela con "No puedo dar esta clase", que
// propone fechas de recuperación y aplica los comodines en el servidor.
//
// Solo la llama una pestaña con la app VIEJA en caché. Para esas, la base ya
// descarta la constancia y la multa (trigger de supabase-penalizaciones-unicas.sql,
// que además deja una campanita al profesor y al admin); aquí se corta el email
// al alumno, que hablaría de una cancelación que no existe.

const MENSAJE = 'Actualiza la página (Ctrl + Shift + R) y usa «No puedo dar esta clase».';

export async function POST(): Promise<Response> {
  return Response.json({ error: 'retirado', mensaje: MENSAJE }, { status: 410 });
}
