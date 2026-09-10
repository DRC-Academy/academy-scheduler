// DATOS DE EJEMPLO de la maqueta del dashboard. Nada de acá sale de la base.
//
// Viven en un módulo aparte porque los consumen DOS vistas de la misma ruta:
// la de escritorio (page.tsx) y la de móvil (DashboardMovil.tsx). Un solo
// juego de números para las dos, así ninguna se desvía de la otra.
//
// Los valores están elegidos para parecerse a la academia real (≈30 profesores,
// ≈170 alumnos) y para que se vean los tres estados de cada semáforo.

export const HOY = new Date();

export const RESUMEN = {
  alumnosActivos: 168,
  alumnosTotales: 191,
  profesoresActivos: 27,
  profesoresTotales: 30,
  clasesSemana: 214,
  clasesSemanaProgramadas: 231,
  costeProfesoresMes: 8420,
  costeProfesoresMesAnterior: 7960,
  ocupacion: 78,          // clases confirmadas / cupos totales
};

export type Tono = 'rojo' | 'amarillo' | 'ok';

export interface Accion {
  /** Identificador estable: la vista móvil elige por acá qué colas muestra. */
  clave: string;
  n: number;
  label: string;
  detalle: string;
  href: string;
  tono: Tono;
}

/** Lo que hay que resolver hoy. `tono` decide el semáforo. */
export const ACCIONES: Accion[] = [
  { clave: 'validaciones', n: 14, label: 'Validaciones pendientes',        detalle: 'la más antigua, 6 días',      href: '/admin?tab=validacion',            tono: 'rojo' },
  { clave: 'emails-tarde', n: 3,  label: 'Emails de presentación tarde',   detalle: 'más de 24 h sin enviar',      href: '/admin?tab=emails&filter=overdue', tono: 'rojo' },
  { clave: 'riesgo', n: 9,  label: 'Alumnos en riesgo',              detalle: 'sin intervención registrada', href: '/admin?tab=ai',                    tono: 'rojo' },
  { clave: 'transcripts', n: 22, label: 'Transcripts sin subir',          detalle: 'clases con acceso registrado', href: '/admin?tab=tracking',             tono: 'amarillo' },
  { clave: 'proximos-cancelar', n: 6,  label: 'Próximos a cancelar sin contactar', detalle: 'les quedan menos de 7 días', href: '/proximos-cancelar',             tono: 'amarillo' },
  { clave: 'solicitudes', n: 4,  label: 'Solicitudes de revisión',        detalle: 'clases que el profe no cobra', href: '/finanzas',                       tono: 'amarillo' },
  { clave: 'sin-profesor', n: 2,  label: 'Alumnos sin profesor',           detalle: 'alta sin asignar',            href: '/dashboard',                       tono: 'amarillo' },
  { clave: 'ia-fallidos', n: 0,  label: 'Análisis de IA fallidos',        detalle: 'sin reintentar',              href: '/admin?tab=tracking',              tono: 'ok' },
];

export const SUSCRIPCIONES = {
  porEstado: [
    { estado: 'active',         label: 'Activas',            n: 141, acceso: true },
    { estado: 'pending-cancel', label: 'Cancelan al final',  n: 12,  acceso: true },
    { estado: 'on-hold',        label: 'En pausa',           n: 7,   acceso: false },
    { estado: 'pending',        label: 'Pendientes de pago', n: 4,   acceso: false },
    { estado: 'cancelled',      label: 'Canceladas',         n: 38,  acceso: false },
  ],
  porOrigen: [
    { origen: 'WooCommerce', n: 129, color: '#1E9E3A' },
    { origen: 'Manual',      n: 24,  color: '#2563eb' },
    { origen: 'Oritalk',     n: 15,  color: '#FFC400' },
  ],
};

/** Últimos 6 meses. `altas` y `bajas` del mes cerrado. */
export const MOVIMIENTO = [
  { mes: 'Abr', altas: 18, bajas: 11 },
  { mes: 'May', altas: 15, bajas: 14 },
  { mes: 'Jun', altas: 21, bajas: 9  },
  { mes: 'Jul', altas: 12, bajas: 16 },
  { mes: 'Ago', altas: 17, bajas: 12 },
  { mes: 'Sep', altas: 9,  bajas: 5  },
];

/** Embudo de captación: cada paso es un subconjunto del anterior. */
export const EMBUDO_NIVEL = [
  { paso: 'Formulario enviado',  n: 96 },
  { paso: 'Formulario completo', n: 71 },
  { paso: 'Test de nivel hecho', n: 45 },
  { paso: 'Primera clase dada',  n: 38 },
];

export const RIESGO = {
  verde: 152,
  rojo: 16,
  urgentes: [
    { alumno: 'Laura Villegas',   profe: 'Johny',     causa: 'Dos faltas seguidas sin aviso',       dias: 12 },
    { alumno: 'Mohamed Al Hakeue', profe: 'Silvia',   causa: 'Pidió bajar la frecuencia',           dias: 9  },
    { alumno: 'Alba Rodríguez',   profe: 'Milagros',  causa: 'Desmotivación detectada en clase',    dias: 7  },
    { alumno: 'Carles Aliaga',    profe: 'Cristian',  causa: 'Plan termina y no renovó',            dias: 5  },
    { alumno: 'Elena Tapia',      profe: 'Wanda',     causa: 'Tres clases seguidas canceladas',     dias: 3  },
  ],
};

export const OPERACION = {
  dadas: 198,
  programadas: 231,
  faltasSinAviso: 7,
  recuperacionesPendientes: 11,
  clases2h: 34,
  franjas: [
    { franja: '08–11', ocupados: 22, libres: 6  },
    { franja: '11–14', ocupados: 31, libres: 3  },
    { franja: '14–17', ocupados: 28, libres: 9  },
    { franja: '17–20', ocupados: 44, libres: 2  },
    { franja: '20–23', ocupados: 19, libres: 14 },
  ],
};

export const PROFESORES = [
  { nombre: 'Johny',     clases: 46, cuposLibres: 0, transcriptsTarde: 0, usaIA: true  },
  { nombre: 'Silvia',    clases: 41, cuposLibres: 2, transcriptsTarde: 3, usaIA: true  },
  { nombre: 'Milagros',  clases: 38, cuposLibres: 1, transcriptsTarde: 0, usaIA: false },
  { nombre: 'Cristian',  clases: 35, cuposLibres: 4, transcriptsTarde: 7, usaIA: false },
  { nombre: 'Wanda',     clases: 33, cuposLibres: 3, transcriptsTarde: 1, usaIA: true  },
  { nombre: 'Victoria',  clases: 29, cuposLibres: 6, transcriptsTarde: 0, usaIA: false },
];

export const IA = { usan: 11, total: 30 };

export const FINANZAS = {
  totalAPagar: 8420,
  montoPagable: 7310,
  montoARevisar: 890,
  montoRetenido: 220,
  bonus: 340,
  penalizaciones: -120,
  mesAnterior: 7960,
  profesoresPagados: 6,
  profesoresTotales: 30,
};

export const HERRAMIENTAS = [
  'Auditoría de vínculos',
  'Sincronización calendario ↔ asignaciones',
  'Sincronización con WooCommerce',
  'Estilo de los textos de IA',
];

// ─────────────────────────────────────────────────────────────────────────────

/** Semáforo de tres tonos. El rojo es solo para urgencia real. */
export const TONO: Record<Tono, { fg: string; bg: string; bd: string; dot: string }> = {
  rojo:     { fg: '#B42318', bg: 'rgba(220,74,56,0.08)',  bd: 'rgba(220,74,56,0.30)',  dot: '#dc4a38' },
  amarillo: { fg: '#8a6d00', bg: 'rgba(255,196,0,0.12)',  bd: 'rgba(255,196,0,0.45)',  dot: '#FFC400' },
  ok:       { fg: '#167A2D', bg: 'rgba(22,122,45,0.07)',  bd: 'rgba(22,122,45,0.22)',  dot: '#1E9E3A' },
};

export const eur = (n: number) => `${n.toLocaleString('es-ES')} €`;

export function fechaLarga(d: Date): string {
  const s = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "Jue 10 sep": la que cabe en la cabecera del móvil. */
export function fechaCorta(d: Date): string {
  const s = d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })
    .replace(/\./g, '').replace(',', '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
