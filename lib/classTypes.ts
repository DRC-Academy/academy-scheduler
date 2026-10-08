// Predicados sobre el TIPO de una clase (class_records.class_type).
//
// Viven aparte de lib/finance.ts porque los necesita lib/transcriptDeadline.ts
// (el plazo del transcript no aplica a la falta del alumno) y finance importa a
// su vez el plazo: tenerlos acá evita el ciclo. Finance los re-exporta, así que
// todo lo que ya hacía `import { isStudentLostClass } from '@/lib/finance'`
// sigue funcionando igual.

import type { ClassRecordType } from '@/types';

/** ¿Es una falta del alumno vigente? Las revertidas por el admin no cuentan. */
export function isStudentAbsence(classType: ClassRecordType | string | undefined): boolean {
  return classType === 'falta_sin_aviso';
}

/**
 * ¿Es una clase que el alumno PERDIÓ por su cuenta? Falta sin aviso o
 * cancelación sobre la hora.
 *
 * Las dos son lo mismo desde el plan del alumno: la hora se reservó, el profesor
 * estuvo, y esa clase ya no se da ni se recupera. Por eso GASTAN UNA CLASE DEL
 * MES, comparten un único tope de cobro (ver LOST_CLASS_MONTHLY_CAP en finance)
 * y NO llevan transcript: no hubo clase que transcribir, así que el plazo de 24 h
 * tampoco les aplica.
 *
 * `isStudentAbsence` sigue existiendo porque hay cosas que solo valen para la
 * falta: el botón "Marcar falta" del profesor, la reversión del admin y el texto
 * que explica la fila. Para preguntar por el cupo, por el tope o por el plazo
 * del transcript, este.
 */
export function isStudentLostClass(classType: ClassRecordType | string | undefined): boolean {
  return isStudentAbsence(classType) || classType === 'cancelacion_hora';
}

/**
 * ¿Es una clase MOVIDA a otra fecha? Constancia 'reprogramada' con destino
 * (`rescheduledTo`). La pongan el profesor ("Reprogramar") o el alumno desde el
 * LMS (autoservicio), es la misma clase en otro día: ni se perdió, ni es una
 * falta, ni una cancelación. Una 'reprogramada' sin destino (filas viejas) no
 * entra aquí y se sigue tratando como antes.
 */
export function isMovedClass(r: { classType?: ClassRecordType | string | null; rescheduledTo?: string | null }): boolean {
  return r.classType === 'reprogramada' && !!r.rescheduledTo;
}
