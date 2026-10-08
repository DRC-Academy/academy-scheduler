// Errores tipados del cambio de horario (mismo profesor). Módulo puro.
// Los códigos son ESTABLES: el LMS los muestra y decide con ellos
// (ver docs/autoservicio-contrato.md).

export type CodigoCambioHorario =
  | 'DATOS_INVALIDOS'            // modo, día, hora, fecha o duración mal formados
  | 'ALUMNO_NO_ENCONTRADO'
  | 'NO_ELEGIBLE'                // ver `detalleNoElegible`
  | 'SESION_NO_ENCONTRADA'       // el alumno no tiene esa sesión en el calendario de su profesor
  | 'MISMO_HORARIO'              // el destino es la misma sesión (y fecha)
  | 'ANTELACION_INSUFICIENTE'    // la clase original o la nueva empiezan a 24 h o menos
  | 'FUERA_DE_VENTANA'           // PUNTUAL: más allá de 6 semanas
  | 'MARCA_PUNTUAL_EXISTENTE'    // PUNTUAL: la casilla de origen o de destino ya tiene una marca vigente
  | 'SLOT_NO_DISPONIBLE'         // el destino no es libre (esHuecoLibreParaAlumno)
  | 'RECUPERACION_PENDIENTE'     // recuperación abierta o reserva viva
  | 'CALENDARIO_SIN_ACTUALIZAR'  // el calendario del profesor lleva más de 30 días sin revisar
  | 'CALENDARIO_ILEGIBLE'
  | 'HUECO_YA_OCUPADO'           // otro cambió una casilla mientras se aplicaba el cambio
  | 'EN_CURSO'                   // misma clave de idempotencia con un cambio sin terminar
  | 'ERROR_LECTURA'              // no se pudo leer la ficha, las asignaciones o las recuperaciones
  | 'ERROR_ESCRITURA';           // la base rechazó una escritura

/** Por qué un alumno no puede usar el autoservicio. Códigos estables. */
export type DetalleNoElegible =
  | 'SIN_ASIGNACION_ACTIVA'
  | 'VARIAS_ASIGNACIONES'
  | 'PLAN_DOS_ALUMNOS'
  | 'EMPRESA'
  | 'ORITALK';
// TODO(en-pausa): 'EN_PAUSA' cuando student_pauses exista en producción (ver lib/cambioHorario/elegibilidad.ts).

export class CambioHorarioError extends Error {
  readonly codigo: CodigoCambioHorario;
  readonly pasoFallido: string;
  readonly completado: string[];
  /** null: no se escribió nada · true: se escribió y se deshizo · false: quedó a medias (aviso al admin). */
  readonly compensada: boolean | null;
  readonly detalles: string[];
  readonly detalleNoElegible: DetalleNoElegible | null;
  /** Cuándo deja de aplicar el motivo (España peninsular), si se sabe. Va al LMS como disponible_desde. */
  readonly disponibleDesde: { fecha: string; hora: string } | null;

  constructor(args: {
    codigo: CodigoCambioHorario; paso: string; mensaje: string;
    completado?: string[]; compensada?: boolean | null; detalles?: string[];
    detalleNoElegible?: DetalleNoElegible | null; disponibleDesde?: { fecha: string; hora: string } | null; cause?: unknown;
  }) {
    super(`[${args.codigo}] ${args.mensaje}`, args.cause !== undefined ? { cause: args.cause } : undefined);
    this.name = 'CambioHorarioError';
    this.codigo = args.codigo;
    this.pasoFallido = args.paso;
    this.completado = args.completado ?? [];
    this.compensada = args.compensada ?? null;
    this.detalles = args.detalles ?? [];
    this.detalleNoElegible = args.detalleNoElegible ?? null;
    this.disponibleDesde = args.disponibleDesde ?? null;
  }

  /** El mensaje sin el prefijo del código. */
  get mensaje(): string { return this.message.replace(/^\[[A-Z_]+\] /, ''); }
}
