// ── Qué enseña el calendario del diploma: hojas, leyenda y enlace ────────────
//
// La parte PURA de components/DiplomaCalendario: entra lo que dijo el LMS (o
// que aún no dijo nada), la fecha de inicio del alumno y el día de hoy, y sale
// qué hojas de calendario se pintan ("5 / MESES", "21 / DÍAS"), la leyenda de
// al lado ("para tu diploma"), el texto del enlace y la frase completa para el
// lector de pantalla. El componente no decide nada: pinta lo que sale de aquí.
//
// Vive aparte para poder probarse con fechas fijas (lib/diplomaCalendario.test.ts):
// el estado "hoy" y los singulares ("1 MES", "1 DÍA") no tienen alumno real que
// los enseñe. El cálculo del plazo en sí (fecha del diploma, días, meses y días
// de calendario, fase) es de lib/diplomaPlazo; aquí solo se traduce a hojas.
//
// LOS ESTADOS, en orden de precedencia:
//   · conseguido (el LMS dice que están todas las lecciones) → una hoja con el
//     sello ✓ y el rótulo DIPLOMA. Manda sobre la fecha;
//   · sin fecha de inicio válida → sin hojas: solo el enlace;
//   · vencido (la fecha pasó y el curso sigue abierto) → una hoja con "¡Retoma!"
//     en lugar del número y el rótulo TU CURSO, y el enlace pasa a "Continuar
//     mi curso →". Sin fecha ni cuenta: una invitación, no un reproche;
//   · hoy → una hoja con HOY;
//   · menos de 31 días → una sola hoja con los días;
//   · más → meses y días (y solo la de los meses cuando los días sueltos son 0).
// Singular y plural concuerdan: 1 MES, 1 DÍA.
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
  irALaPlataforma: 'Ir a la plataforma →',
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
  leyenda: string | null;
  enlace: string;
  /** La frase completa para el lector de pantalla: las hojas y la leyenda leídas de corrido. */
  frase: string | null;
}

/** Qué hojas, qué leyenda y qué enlace le tocan a este alumno. */
export function dibujoDe(diploma: DiplomaEstadoSlot, startDate: string | null, hoy: string): Dibujo {
  if (diploma !== 'cargando' && diploma?.estado === 'conseguido') {
    return {
      hojas: [{ valor: '', rotulo: T.diploma, sello: true }],
      leyenda: T.cursoCompletado, enlace: T.irALaPlataforma, frase: T.diplomaConseguido,
    };
  }

  const plazo: Plazo | null = calcularPlazo(startDate, hoy);
  if (!plazo) return { hojas: [], leyenda: null, enlace: T.irALaPlataforma, frase: null };

  switch (plazo.fase) {
    case 'vencido':
      return {
        hojas: [{ valor: T.retoma, rotulo: T.tuCurso, palabra: true }],
        leyenda: T.yConsigueTuDiploma, enlace: T.continuarMiCurso, frase: T.diplomaTeEspera,
      };
    case 'hoy':
      return {
        hojas: [{ valor: T.hoy, rotulo: T.diploma, corta: true }],
        leyenda: T.tuDiplomaEsHoy, enlace: T.irALaPlataforma, frase: titularPlazo(plazo),
      };
    case 'dias':
    case 'ultima-semana':
      return {
        hojas: [{ valor: plazo.dias, rotulo: T.dia(plazo.dias) }],
        leyenda: T.paraTuDiploma, enlace: T.irALaPlataforma, frase: `${titularPlazo(plazo)} ${T.paraTuDiploma}`,
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
      return { hojas, leyenda: T.paraTuDiploma, enlace: T.irALaPlataforma, frase: `${titularPlazo(plazo)} ${T.paraTuDiploma}` };
    }
  }
}
