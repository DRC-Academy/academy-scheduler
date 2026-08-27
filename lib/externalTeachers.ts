// ── Profesores que NO salen por los endpoints externos ───────────────────────
//
// Alcance: TODO /api/external/*. Vive en su propio módulo, y no dentro de
// lib/externalPayouts, justamente para que el próximo endpoint que exponga
// profesores tenga un único sitio del que importar el criterio en vez de
// reescribirlo. Dos listas de "profesores de prueba" divergen igual de rápido
// que dos definiciones de "cuánto se le debe".
//
// QUÉ NO HACE: no los borra ni los oculta en DRC Gestión. Siguen en la tabla
// `teachers`, con su calendario, sus alumnos y sus finanzas, y el admin los ve
// en /finanzas como siempre. Lo único que cambia es que el dashboard financiero
// externo no los cuenta — son cuentas de prueba y ensuciaban
// `active_teachers_now`, `facturacion_total` y el margen del mes.
//
// SE EXCLUYE POR ID, no por el "(test)" del nombre. El nombre es un campo que
// se edita desde el admin: si mañana alguien le quita el sufijo a `t1`, una
// regla basada en el texto lo dejaría entrar sin que nadie lo note, y una
// basada en buscar "test" dentro del nombre acabaría tapando a un profesor real
// que se llame parecido. El id es estable y no se edita.
//
// PARA AÑADIR OTRO: sumá su id acá abajo y listo — lo aplican todos los
// endpoints externos a la vez.

/** Ids de las cuentas de prueba. Ver el porqué del criterio arriba. */
export const PROFESORES_DE_PRUEBA: ReadonlySet<string> = new Set([
  't1',   // Sebastian (test)
  't2',   // Mauricio (test)
]);

/** true si ese id es una cuenta de prueba y no debe salir por /api/external/*. */
export function esProfesorDePrueba(teacherId: string): boolean {
  return PROFESORES_DE_PRUEBA.has(teacherId);
}

/** Quita las cuentas de prueba de cualquier lista con `id`. No muta la original. */
export function sinProfesoresDePrueba<T extends { id: string }>(teachers: readonly T[]): T[] {
  return teachers.filter(t => !esProfesorDePrueba(t.id));
}
