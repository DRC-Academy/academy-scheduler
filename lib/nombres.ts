// Utilidades de nombres para los textos. Módulo PURO (sin Resend ni Supabase).

/** Nombre de pila: los nombres llegan completos y en el saludo quedan fríos. */
export function primerNombre(nombre: string): string {
  const limpio = (nombre ?? '').trim().replace(/\s+/g, ' ');
  if (!limpio) return '';
  const primera = limpio.split(' ')[0];
  // Hay nombres cargados EN MAYÚSCULAS. "JOSÉ" en el saludo parece un grito.
  return primera === primera.toUpperCase() && primera.length > 1
    ? primera.charAt(0) + primera.slice(1).toLowerCase()
    : primera;
}
