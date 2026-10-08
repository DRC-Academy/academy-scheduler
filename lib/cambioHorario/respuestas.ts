// Respuestas HTTP del autoservicio del LMS (/api/lms/autoservicio/*). Módulo
// puro. Contrato: docs/autoservicio-contrato.md.
//
// Error: { ok: false, codigo, mensaje[, detalle_no_elegible] }. `mensaje` está
// listo para enseñárselo al alumno (español de España, tú). El LMS decide SOLO
// por `ok`: un cambio cuenta como hecho únicamente con `ok: true`.

import { CambioHorarioError, type CodigoCambioHorario } from '@/lib/cambioHorario/errors';
import { requireLmsSecret } from '@/lib/lmsAuth';

/** Códigos de la capa HTTP que no vienen del núcleo. */
export type CodigoHttp = 'NO_AUTORIZADO' | 'NO_CONFIGURADO' | 'ERROR_INTERNO';
export type CodigoAutoservicio = CodigoCambioHorario | CodigoHttp;

export const ESTADO_HTTP: Record<CodigoAutoservicio, number> = {
  DATOS_INVALIDOS: 422,
  MISMO_HORARIO: 422,
  FUERA_DE_VENTANA: 422,
  ALUMNO_NO_ENCONTRADO: 404,
  SESION_NO_ENCONTRADA: 404,
  NO_ELEGIBLE: 403,
  ANTELACION_INSUFICIENTE: 409,
  MARCA_PUNTUAL_EXISTENTE: 409,
  SLOT_NO_DISPONIBLE: 409,
  RECUPERACION_PENDIENTE: 409,
  CALENDARIO_SIN_ACTUALIZAR: 409,
  HUECO_YA_OCUPADO: 409,
  EN_CURSO: 409,
  CALENDARIO_ILEGIBLE: 503,
  ERROR_LECTURA: 503,
  ERROR_ESCRITURA: 500,
  NO_AUTORIZADO: 401,
  NO_CONFIGURADO: 503,
  ERROR_INTERNO: 500,
};

export const MENSAJE: Record<CodigoAutoservicio, string> = {
  DATOS_INVALIDOS: 'No hemos entendido la petición. Recarga la página e inténtalo de nuevo.',
  MISMO_HORARIO: 'Ese ya es tu horario. Elige otro hueco.',
  FUERA_DE_VENTANA: 'Solo puedes mover clases de las próximas 6 semanas.',
  ALUMNO_NO_ENCONTRADO: 'No encontramos tu ficha de alumno. Escríbenos y lo revisamos.',
  SESION_NO_ENCONTRADA: 'Esa clase ya no está en tu horario. Recarga la página para ver el horario actual.',
  NO_ELEGIBLE: 'Con tu plan, los cambios de horario los gestionamos nosotros. Escríbenos y te ayudamos.',
  ANTELACION_INSUFICIENTE: 'Los cambios se hacen con más de 24 horas de antelación.',
  MARCA_PUNTUAL_EXISTENTE: 'Ya has movido una clase de este horario. Podrás mover otra cuando pase esa semana.',
  SLOT_NO_DISPONIBLE: 'Ese hueco ya no está libre. Elige otro.',
  RECUPERACION_PENDIENTE: 'Tienes una recuperación de clase pendiente. Cuando esté resuelta podrás cambiar tu horario.',
  CALENDARIO_SIN_ACTUALIZAR: 'Ahora mismo no podemos ofrecerte huecos con tu profesor. Escríbenos y lo gestionamos nosotros.',
  HUECO_YA_OCUPADO: 'Alguien acaba de ocupar ese hueco. Elige otro.',
  EN_CURSO: 'Tu cambio se está procesando. Espera unos segundos y recarga la página.',
  CALENDARIO_ILEGIBLE: 'No hemos podido consultar el calendario. Inténtalo de nuevo en unos minutos.',
  ERROR_LECTURA: 'No hemos podido consultar tus datos. Inténtalo de nuevo en unos minutos.',
  ERROR_ESCRITURA: 'No hemos podido guardar el cambio. Inténtalo de nuevo en unos minutos.',
  NO_AUTORIZADO: 'Petición no autorizada.',
  NO_CONFIGURADO: 'El servicio no está disponible ahora mismo.',
  ERROR_INTERNO: 'Ha habido un problema. Inténtalo de nuevo en unos minutos.',
};

/** Un cambio que quedó a medias: no se reintenta, el equipo ya tiene el aviso. */
const MENSAJE_A_MEDIAS = 'Ha habido un problema al guardar el cambio y el equipo ya está avisado. No lo intentes de nuevo: te escribiremos.';

export interface CuerpoError {
  ok: false;
  codigo: CodigoAutoservicio;
  mensaje: string;
  detalle_no_elegible?: string;
}

const SIN_CACHE = { 'Cache-Control': 'no-store' };

export function respuestaOk(cuerpo: object): Response {
  return Response.json({ ...cuerpo, ok: true }, { headers: SIN_CACHE });
}

export function respuestaCodigo(codigo: CodigoAutoservicio, extra: Partial<CuerpoError> = {}): Response {
  const cuerpo: CuerpoError = { ok: false, codigo, mensaje: MENSAJE[codigo], ...extra };
  return Response.json(cuerpo, { status: ESTADO_HTTP[codigo], headers: SIN_CACHE });
}

/**
 * La misma comprobación de x-lms-secret que /api/lms/recuperaciones
 * (lib/lmsAuth.ts), con el cuerpo de error de este contrato. null = autorizada.
 */
export function autorizarLms(request: Request): Response | null {
  const denegada = requireLmsSecret(request);
  if (!denegada) return null;
  return respuestaCodigo(denegada.status === 503 ? 'NO_CONFIGURADO' : 'NO_AUTORIZADO');
}

/** Traduce cualquier error a la respuesta del contrato. Los inesperados se registran. */
export function respuestaError(err: unknown, etiqueta: string): Response {
  if (err instanceof CambioHorarioError) {
    if (ESTADO_HTTP[err.codigo] >= 500) console.error(`[${etiqueta}] ${err.codigo}:`, err.message);
    return respuestaCodigo(err.codigo, {
      ...(err.compensada === false ? { mensaje: MENSAJE_A_MEDIAS } : {}),
      ...(err.detalleNoElegible ? { detalle_no_elegible: err.detalleNoElegible } : {}),
    });
  }
  console.error(`[${etiqueta}]`, err);
  return respuestaCodigo('ERROR_INTERNO');
}
