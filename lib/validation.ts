// Validaciones compartidas de formularios.
//
// El email es la CLAVE con la que el alumno se cruza con WooCommerce (plan,
// suscripción, fecha de inicio) y con la que se le manda el formulario inicial.
// Los inputs son type="email", pero como no están dentro de un <form> el
// navegador nunca valida: hay que comprobarlo a mano antes de guardar.

/** Formato de email razonable: algo@algo.algo, sin espacios. */
export function isValidEmail(email: string | null | undefined): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((email ?? '').trim());
}

/** El email es opcional en algunos formularios: vacío pasa, pero mal escrito no. */
export function isValidOptionalEmail(email: string | null | undefined): boolean {
  const v = (email ?? '').trim();
  return v === '' || isValidEmail(v);
}
