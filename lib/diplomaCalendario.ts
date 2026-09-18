// ── Qué enseña el calendario del diploma: hojas, leyenda y enlace ────────────
//
// La parte PURA de components/DiplomaCalendario: entra lo que dijo el LMS (o
// que aún no dijo nada), la fecha de inicio del alumno y el día de hoy, y sale
// qué hojas de calendario se pintan ("1 / MES", "9 / DÍAS"), la leyenda de al
// lado ("para tu diploma"), la línea de lecciones debajo ("38 de 168
// lecciones"), el texto del enlace y la frase completa para el lector de
// pantalla. El componente no decide nada: pinta lo que sale de aquí.
//
// Vive aparte para poder probarse con fechas fijas (lib/diplomaCalendario.test.ts):
// el estado "hoy" y los singulares ("1 MES", "1 DÍA") no tienen alumno real que
// los enseñe. El cálculo del plazo en sí (fecha del diploma, días, meses y días
// de calendario, fase) es de lib/diplomaPlazo; aquí solo se traduce a hojas.
//
// LOS ESTADOS, en orden de precedencia:
//   · conseguido (el LMS dice que están todas las lecciones) → una hoja con el
//     sello ✓ y el rótulo DIPLOMA. Manda sobre la fecha;
//   · sin fecha de inicio válida → sin hojas: la línea de lecciones y el enlace;
//   · vencido (la fecha pasó y el curso sigue abierto) → una hoja con "¡Retoma!"
//     en lugar del número y el rótulo TU CURSO, y el enlace pasa a "Continuar
//     mi curso →". Sin fecha ni cuenta: una invitación, no un reproche;
//   · hoy → una hoja con HOY;
//   · menos de 31 días → una sola hoja con los días;
//   · más → meses y días (y solo la de los meses cuando los días sueltos son 0).
// Singular y plural concuerdan: 1 MES, 1 DÍA.
//
// EL ENLACE: "Ir a la plataforma →" de normal; "Empezar mi curso →" para quien
// tiene el curso y cero lecciones hechas; "Continuar mi curso →" en vencido
// (aunque lleve cero: la hoja ya le dice "¡Retoma!", y "Empezar" la
// contradiría). Conseguido vuelve a "Ir a la plataforma →".
//
// LAS LECCIONES vienen del LMS ("38 de 168 lecciones"): null mientras carga, si
// no contestó o si el alumno no tiene curso. Es la única línea que puede llegar
// tarde; el componente le reserva el sitio para que nada salte.
//
// SIEMPRE "LECCIONES", NUNCA "CLASES": las clases son las del profesor y se
// cuentan en otro sitio. La palabra es la única pista que tiene el alumno para
// no mezclar los dos números.
//
// 'cargando' (el LMS aún no contestó) y null (no contestó, o el alumno no tiene
// curso en el LMS) se tratan igual: cuenta por fecha. El plazo es una regla de
// la academia (seis meses desde que empezó con su profesor), no del LMS.

import type { Diploma } from '@/lib/diplomaTypes';
import { calcularPlazo, titularPlazo, type Plazo } from '@/lib/diplomaPlazo';

/** 'cargando' mientras se espera al LMS; null cuando no contestó o no aplica. */
export type DiplomaEstadoSlot = Diploma | null | 'cargando';

// ─── Textos ──────────────────────────────────────────────────────────────────

export const T = {
  paraTuDiploma: 'para tu diploma',
  lecciones: (hechas: number, total: number) => `${hechas} de ${total} lecciones`,
  irALaPlataforma: 'Ir a la plataforma →',
  empezarMiCurso: 'Empezar mi curso →',
  // Vencido
  retoma: '¡Retoma!',
  tuCurso: 'Tu curso',
  yConsigueTuDiploma: 'y consigue tu diploma',
  continuarMiCurso: 'Continuar mi curso →',
  diplomaTeEspera: 'Tu diploma te espera: retoma tu curso y consíguelo.',
  // Hoy
  hoy: 'Hoy',
  diploma: 'Diploma',
  tuDiplomaEsHoy: 'Tu diploma es hoy',
  // Conseguido
  cursoCompletado: 'Curso completado',
  diplomaConseguido: 'Diploma conseguido',
  // Unidades de las hojas
  mes: (n: number) => (n === 1 ? 'Mes' : 'Meses'),
  dia: (n: number) => (n === 1 ? 'Día' : 'Días'),
};

// ─── Las hojas ───────────────────────────────────────────────────────────────

export interface Hoja {
  /** Lo grande: un número, o una palabra corta ("Hoy", "¡Retoma!"). */
  valor: number | string;
  rotulo: string;
  /** Una palabra en vez de un número ("¡Retoma!"): cuerpo menor y la hoja se ensancha lo justo. */
  palabra?: boolean;
  /** Una palabra corta ("Hoy"): cabe en la hoja de siempre, a un cuerpo entre el número y la palabra. */
  corta?: boolean;
  /** El sello ✓ del diploma conseguido, dibujado en vez de escrito. */
  sello?: boolean;
}

export interface Dibujo {
  hojas: Hoja[];
  /** La línea de al lado de las hojas ("para tu diploma"). Null sin hojas. */
  leyenda: string | null;
  /** "38 de 168 lecciones", o null si el LMS no lo dijo (todavía, o nunca). */
  lecciones: string | null;
  enlace: string;
  /** La frase completa para el lector de pantalla: hojas, leyenda y lecciones de corrido. */
  frase: string | null;
}

/** "38 de 168 lecciones" si el LMS contestó con un curso; null en cualquier otro caso. */
function leccionesDe(diploma: DiplomaEstadoSlot): string | null {
  if (diploma === 'cargando' || !diploma || diploma.estado === 'sin-curso' || !(diploma.total > 0)) return null;
  return T.lecciones(Math.min(diploma.completadas, diploma.total), diploma.total);
}

/** ¿Tiene curso en el LMS y no ha hecho ninguna lección? */
function sinEmpezar(diploma: DiplomaEstadoSlot): boolean {
  return diploma !== 'cargando' && !!diploma && diploma.estado === 'en-curso' && diploma.completadas === 0;
}

/** Qué hojas, qué leyenda, qué lecciones y qué enlace le tocan a este alumno. */
export function dibujoDe(diploma: DiplomaEstadoSlot, startDate: string | null, hoy: string): Dibujo {
  const lecciones = leccionesDe(diploma);
  const conLecciones = (frase: string | null) => (frase && lecciones ? `${frase}. ${lecciones}.` : frase ?? lecciones);
  const enlaceNormal = sinEmpezar(diploma) ? T.empezarMiCurso : T.irALaPlataforma;

  if (diploma !== 'cargando' && diploma?.estado === 'conseguido') {
    return {
      hojas: [{ valor: '', rotulo: T.diploma, sello: true }],
      leyenda: T.cursoCompletado, lecciones, enlace: T.irALaPlataforma, frase: conLecciones(T.diplomaConseguido),
    };
  }

  const plazo: Plazo | null = calcularPlazo(startDate, hoy);
  if (!plazo) return { hojas: [], leyenda: null, lecciones, enlace: enlaceNormal, frase: conLecciones(null) };

  switch (plazo.fase) {
    case 'vencido':
      return {
        hojas: [{ valor: T.retoma, rotulo: T.tuCurso, palabra: true }],
        leyenda: T.yConsigueTuDiploma, lecciones, enlace: T.continuarMiCurso, frase: conLecciones(T.diplomaTeEspera),
      };
    case 'hoy':
      return {
        hojas: [{ valor: T.hoy, rotulo: T.diploma, corta: true }],
        leyenda: T.tuDiplomaEsHoy, lecciones, enlace: enlaceNormal, frase: conLecciones(titularPlazo(plazo)),
      };
    case 'dias':
    case 'ultima-semana':
      return {
        hojas: [{ valor: plazo.dias, rotulo: T.dia(plazo.dias) }],
        leyenda: T.paraTuDiploma, lecciones, enlace: enlaceNormal,
        frase: conLecciones(`${titularPlazo(plazo)} ${T.paraTuDiploma}`),
      };
    case 'meses': {
      // Con más de 30 días siempre cabe al menos un mes; el respaldo en días
      // es por si algún día cambia el umbral en lib/diplomaPlazo.
      const hojas: Hoja[] = plazo.meses === 0
        ? [{ valor: plazo.dias, rotulo: T.dia(plazo.dias) }]
        : [
            { valor: plazo.meses, rotulo: T.mes(plazo.meses) },
            ...(plazo.diasSueltos > 0 ? [{ valor: plazo.diasSueltos, rotulo: T.dia(plazo.diasSueltos) }] : []),
          ];
      return {
        hojas, leyenda: T.paraTuDiploma, lecciones, enlace: enlaceNormal,
        frase: conLecciones(`${titularPlazo(plazo)} ${T.paraTuDiploma}`),
      };
    }
  }
}
