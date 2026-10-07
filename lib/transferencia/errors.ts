// Errores tipados de la transferencia de alumno (cambio de profesor).
// Módulo puro: lo importan el núcleo, las pantallas y el servidor.

export type CodigoTransferencia =
  | 'DATOS_INVALIDOS'          // sin horarios, horarios repetidos, mal formados
  | 'ASIGNACION_NO_EXISTE'
  | 'ASIGNACION_INACTIVA'
  | 'MISMO_PROFESOR'
  | 'PROFESOR_NO_EXISTE'
  | 'PROFESOR_ARCHIVADO'
  | 'PROFESOR_DE_PRUEBA'
  | 'HORAS_NO_COINCIDEN'       // con origen 'lms': cantidad de horarios ≠ weekly_hours
  | 'SLOT_NO_DISPONIBLE'       // la casilla destino no es libre según el criterio del origen
  | 'RECUPERACION_PENDIENTE'   // el alumno tiene una recuperación abierta (solo bloquea con origen 'lms')
  | 'CALENDARIO_ILEGIBLE'
  | 'HUECO_YA_OCUPADO'         // otro cambió una casilla mientras se aplicaba el patch
  | 'ASIGNACION_CAMBIADA'      // la asignación cambió de profesor o de estado mientras tanto
  | 'EN_CURSO'                 // misma clave de idempotencia con una transferencia sin terminar
  | 'ERROR_ESCRITURA';         // la base rechazó una escritura

/**
 * Fallo de una transferencia, con el detalle de QUÉ alcanzó a hacerse.
 *
 * `compensada`:
 *   · null  → falló antes de escribir nada; no hubo nada que deshacer.
 *   · true  → se había escrito algo y se deshizo entero.
 *   · false → se había escrito algo y NO se pudo deshacer todo: queda un estado
 *             intermedio (detallado en `completado`) y el admin recibió un aviso.
 */
export class TransferenciaError extends Error {
  readonly codigo: CodigoTransferencia;
  readonly pasoFallido: string;
  readonly completado: string[];
  readonly compensada: boolean | null;
  /** Detalle legible por casilla (SLOT_NO_DISPONIBLE, HUECO_YA_OCUPADO…). */
  readonly detalles: string[];

  constructor(args: {
    codigo: CodigoTransferencia; paso: string; mensaje: string;
    completado?: string[]; compensada?: boolean | null; detalles?: string[]; cause?: unknown;
  }) {
    super(`[${args.codigo}] Falló en "${args.paso}": ${args.mensaje}`, args.cause !== undefined ? { cause: args.cause } : undefined);
    this.name = 'TransferenciaError';
    this.codigo = args.codigo;
    this.pasoFallido = args.paso;
    this.completado = args.completado ?? [];
    this.compensada = args.compensada ?? null;
    this.detalles = args.detalles ?? [];
  }

  // Alias con los nombres del TransferError anterior (pantallas y script).
  get failedStep(): string { return this.pasoFallido; }
  get completed(): string[] { return this.completado; }

  /** Mensaje listo para mostrarle al usuario, con el estado real del sistema. */
  get userMessage(): string {
    const motivo = this.message.replace(/^\[[A-Z_]+\] /, '');
    if (this.compensada === null) return `El cambio de profesor no se hizo. ${motivo}`;
    if (this.compensada) return `El cambio de profesor no se hizo y se deshizo lo que se había empezado. ${motivo}`;
    const hecho = this.completado.length ? ` Lo que quedó hecho: ${this.completado.join('; ')}.` : '';
    return `El cambio de profesor quedó A MEDIAS (${motivo}).${hecho} `
         + 'Se avisó al admin; revisá "Auditoría de vínculos" en el panel para completarlo.';
  }
}
