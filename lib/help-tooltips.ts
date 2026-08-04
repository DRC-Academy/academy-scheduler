// Diccionario centralizado de textos de ayuda contextual (tooltips "?").
//
// Fuente ÚNICA de los textos que muestra components/ui/HelpTooltip. Organizado por
// sección/feature. Las claves se referencian por ruta con puntos, p. ej.
// <HelpTooltip tooltipKey="finanzas.transcript" />. Textos en español, orientados a
// una academia de inglés online (alumnos, profesores, clases, pagos, suscripciones).

export const helpTexts = {
  // ── Finanzas del profesor (/mis-clases) ──────────────────────────────────────
  finanzas: {
    ingresoDetectado:  'Se registró tu acceso a la clase con el botón “Ingresar a clase”. Es lo que hace que la clase entre a finanzas.',
    sinIngreso:        'No hay registro de acceso para esta clase. Solo cuenta el ingreso hecho en vivo con el botón “Ingresar a clase”; no se puede cargar después, y sin él la clase no entra al pago.',
    ingreso:           'Cómo entraste a la clase (botón “Ingresar a clase”): a tiempo, tarde o sin registro. Sin ingreso la clase no aparece en finanzas.',
    transcript:        'El texto de la clase que genera Fathom, pegado en “Añadir clase”. Decide si la clase se cobra: sin él queda “pendiente de transcript” y no suma al total.',
    suscripcion:       'Estado de la suscripción del alumno en WooCommerce en el momento de la clase.',
    tarifa:            'Tarifa por clase según el tipo de plan del alumno y su antigüedad (menos o más de 30 días).',
    totalCobrar:       'Lo que cobrás este mes: SOLO las clases pagables (ingreso + transcript), más bonos y menos penalizaciones. Lo pendiente de transcript no está incluido.',
    pagables:          'Clases con ingreso registrado y transcript subido. Son las que se pagan.',
    aRevisar:          'Clases que diste y entraron por tu ingreso, pero que todavía no se pagan porque falta el transcript. Al subirlo pasan solas a pagables.',
    bonosScoring:      'Importe de bonos por tu puntaje de desempeño (scoring) que se suma a la liquidación del mes.',
    tipoClase:         'Tipo de registro: clase normal, recuperación, falta sin aviso o cancelación sobre la hora. Solo normal y recuperación cuentan para el seguimiento de clases.',
    pegarTranscript:   'Abre “Añadir clase” con el alumno y la fecha ya cargados para que solo pegues el transcript y verifiques esa clase.',
  },

  // ── Asistencias del profesor (/asistencias) ──────────────────────────────────
  asistencias: {
    conIngreso:  'Clases de esta semana en las que quedó registrado tu ingreso.',
    puntualidad: 'Porcentaje de tus clases con ingreso a tiempo respecto de todas en las que ingresaste.',
    noIngreso:   'Clases pasadas sin registro de ingreso: no usaste el botón “Ingresar a clase”.',
    proximas:    'Clases programadas de esta semana que todavía no ocurrieron.',
    estado:      'Resultado del acceso: a tiempo, tarde, muy tarde, no ingresó o próxima.',
    horaIngreso: 'Hora real en la que tocaste “Ingresar a clase”. Se compara con la hora programada para calcular la puntualidad.',
  },

  // ── Calendario / Próximas clases (/teacher) ──────────────────────────────────
  calendario: {
    ingresarClase:     'Registra tu acceso a la clase y verifica la suscripción del alumno. Es obligatorio para que la clase cuente para el pago.',
    emailPresentacion: 'Email de bienvenida al alumno nuevo. Enviarlo dentro de las primeras 24 h evita el descuento de scoring.',
    estadoCelda:       'Estado del horario: libre, ocupado (alumno asignado) o bloqueado (no disponible).',
    hito:              'Clases clave (1, 15, 30 y 50). En la 15 hay que grabar la sesión con Fathom y pedir una reseña.',
  },

  // ── Alumnos / ficha (/mis-alumnos) ───────────────────────────────────────────
  alumnos: {
    plan:            'Plan de suscripción del alumno según WooCommerce. Se clasifica en Exámenes, Intensivo o Inglés general.',
    profesorVinculado:'Profesor asignado actualmente al alumno. Se puede cambiar desde la asignación.',
    progreso:        'Progreso del alumno del 1 al 10, estimado por la IA a partir del análisis de sus clases.',
    trayectoria:     'Clases dadas hacia el próximo hito (1 · 15 · 30 · 50). Se cuentan por las clases efectivamente registradas.',
    riesgo:          'Señal de riesgo de baja del alumno según su actividad, asistencia y feedback de las clases.',
    nivel:           'Nivel de inglés del alumno (MCER: A1 a C2).',
    formularioInicial:'Formulario de onboarding que completa el alumno antes de la primera clase; alimenta la ficha con IA.',
  },

  // ── Panel de profesores / admin ──────────────────────────────────────────────
  profesores: {
    clasesRegistradas: 'Clases con ingreso registrado en el rango de fechas seleccionado.',
    clasesPerdidas:    'Clases programadas que no tienen registro de ingreso.',
    sinEnlace:         'Clases cuyo alumno todavía no tiene enlace de Meet cargado.',
    scoring:           'Puntaje del profesor según puntualidad, envío de emails, hitos cumplidos y otras métricas internas.',
    clasificacionPlan: 'Cómo se clasifica el plan del alumno (Exámenes, Intensivo o Inglés general) para tarifas y contenido.',
    verificacionWoo:   'Verificación del estado de la suscripción del alumno contra WooCommerce en tiempo real.',
    retencion:         'Retención del profesor: alumnos activos sobre el total (activos más bajas de los últimos 90 días).',
  },

  // ── Suscripción (WooCommerce) ────────────────────────────────────────────────
  suscripcion: {
    activa:      'La suscripción del alumno está activa y al día en WooCommerce.',
    inactiva:    'El alumno ingresó sin suscripción activa. Queda marcado para revisión del admin.',
    noVerificado:'No se pudo verificar la suscripción en WooCommerce en ese momento.',
  },

  // ── Scoring / bonos ──────────────────────────────────────────────────────────
  scoring: {
    bono6meses:  'Bono de retención que se habilita cuando el alumno cumple 6 meses de clases con vos.',
    emailTardio: 'Penalización de −5 puntos si el email de presentación se envía pasadas las 24 h de la asignación.',
  },
} as const;

// ── Tipado de claves por ruta con puntos ("finanzas.transcript") ──────────────
type Join<K extends string | number, P extends string> = P extends '' ? `${K}` : `${K}.${P}`;
type Paths<T> = T extends string
  ? ''
  : { [K in keyof T & string]: Join<K, Paths<T[K]>> }[keyof T & string];

export type HelpTooltipKey = Paths<typeof helpTexts>;

/** Resuelve una clave con puntos ("seccion.clave") al texto de ayuda. */
export function getHelpText(key: string): string {
  let cur: unknown = helpTexts;
  for (const part of key.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      cur = undefined;
      break;
    }
  }
  if (typeof cur === 'string') return cur;
  if (process.env.NODE_ENV !== 'production') {
    console.warn(`[HelpTooltip] clave de ayuda no encontrada: "${key}"`);
  }
  return '';
}
