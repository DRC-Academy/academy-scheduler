// ── Qué enseña el banner del diploma: cifras, titular, leyenda y botón ───────
//
// La parte PURA de components/DiplomaCalendario: entra lo que dijo el LMS (o
// que aún no dijo nada), la fecha de inicio del alumno y el día de hoy, y sale
// qué va a la izquierda del banner (las cifras "4 MESES  6 DÍAS", la palabra
// HOY, o un titular cuando no hay cuenta), la leyenda de al lado ("para tu
// diploma"), la línea de lecciones debajo ("38 de 168 lecciones"), el texto del
// botón y la frase para el lector de pantalla. El componente no decide nada:
// pinta lo que sale de aquí.
//
// (El nombre del módulo viene de cuando esto eran hojas de calendario de
// sobremesa, del 18 al 21/09/2026; el 21/09 pasó a banner de ancho completo.)
//
// Vive aparte para poder probarse con fechas fijas (lib/diplomaCalendario.test.ts):
// el estado "hoy" y los singulares ("1 MES", "1 DÍA") no tienen alumno real que
// los enseñe. El cálculo del plazo en sí (fecha del diploma, días, meses y días
// de calendario, fase) es de lib/diplomaPlazo; aquí solo se traduce a banner.
//
// LOS ESTADOS, en orden de precedencia:
//   · conseguido (el LMS dice que están todas las lecciones) → titular "Diploma
//     conseguido ✓" y botón "Ver mi curso →". Manda sobre la fecha;
//   · sin fecha de inicio válida → null: el banner NO se muestra;
//   · vencido (la fecha pasó y el curso sigue abierto) → titular "¡Retoma tu
//     curso y consigue tu diploma!" y botón "Continuar mi curso →". Sin fecha ni
//     cuenta: una invitación, no un reproche;
//   · hoy → la palabra HOY donde van las cifras, "es el día de tu diploma";
//   · menos de 31 días → solo los días;
//   · más → meses y días (y solo los meses cuando los días sueltos son 0).
// Singular y plural concuerdan: 1 MES, 1 DÍA.
//
// EL BOTÓN: "Ir a la plataforma →" de normal; "Empezar mi curso →" para quien
// tiene el curso y cero lecciones hechas; "Continuar mi curso →" en vencido
// (aunque lleve cero: el titular ya dice "Retoma", y "Empezar" lo
// contradiría); "Ver mi curso →" en conseguido.
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
  retomaTuCurso: '¡Retoma tu curso y consigue tu diploma!',
  continuarMiCurso: 'Continuar mi curso →',
  // Hoy
  hoy: 'Hoy',
  esElDiaDeTuDiploma: 'es el día de tu diploma',
  tuDiplomaEsHoy: 'Tu diploma es hoy',
  // Conseguido
  diplomaConseguido: 'Diploma conseguido ✓',
  verMiCurso: 'Ver mi curso →',
  // Unidades de las cifras
  mes: (n: number) => (n === 1 ? 'Mes' : 'Meses'),
  dia: (n: number) => (n === 1 ? 'Día' : 'Días'),
};

// ─── El banner ───────────────────────────────────────────────────────────────

/** Una cifra con su unidad: 4 / "Meses". La unidad se pinta en mayúsculas. */
export interface Cifra {
  valor: number;
  unidad: string;
}

export interface Banner {
  /** Qué va a la izquierda: las cifras, la palabra HOY, o un titular sin cuenta. */
  tipo: 'cuenta' | 'hoy' | 'vencido' | 'conseguido';
  /** Solo con tipo 'cuenta': una o dos cifras. */
  cifras: Cifra[];
  /** El texto grande cuando no hay cifras: "Hoy", "¡Retoma tu curso…", "Diploma conseguido ✓". */
  titular: string | null;
  /** La línea de al lado de las cifras ("para tu diploma"). Null con titular de vencido o conseguido. */
  leyenda: string | null;
  /** "38 de 168 lecciones", o null si el LMS no lo dijo (todavía, o nunca). */
  lecciones: string | null;
  /** El texto del botón. */
  enlace: string;
  /** Lo que lee el lector de pantalla en vez de las cifras sueltas ("Te quedan 4 meses y 6 días para tu diploma"). Null cuando el titular ya es texto corrido. */
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

/** Qué banner le toca a este alumno; null si no se enseña ninguno (sin fecha de inicio y sin diploma). */
export function bannerDe(diploma: DiplomaEstadoSlot, startDate: string | null, hoy: string): Banner | null {
  const lecciones = leccionesDe(diploma);
  const enlaceNormal = sinEmpezar(diploma) ? T.empezarMiCurso : T.irALaPlataforma;

  if (diploma !== 'cargando' && diploma?.estado === 'conseguido') {
    return { tipo: 'conseguido', cifras: [], titular: T.diplomaConseguido, leyenda: null, lecciones, enlace: T.verMiCurso, frase: null };
  }

  const plazo: Plazo | null = calcularPlazo(startDate, hoy);
  if (!plazo) return null;

  switch (plazo.fase) {
    case 'vencido':
      return { tipo: 'vencido', cifras: [], titular: T.retomaTuCurso, leyenda: null, lecciones, enlace: T.continuarMiCurso, frase: null };
    case 'hoy':
      return { tipo: 'hoy', cifras: [], titular: T.hoy, leyenda: T.esElDiaDeTuDiploma, lecciones, enlace: enlaceNormal, frase: T.tuDiplomaEsHoy };
    case 'dias':
    case 'ultima-semana':
      return {
        tipo: 'cuenta', cifras: [{ valor: plazo.dias, unidad: T.dia(plazo.dias) }],
        titular: null, leyenda: T.paraTuDiploma, lecciones, enlace: enlaceNormal,
        frase: `${titularPlazo(plazo)} ${T.paraTuDiploma}`,
      };
    case 'meses': {
      // Con más de 30 días siempre cabe al menos un mes; el respaldo en días
      // es por si algún día cambia el umbral en lib/diplomaPlazo.
      const cifras: Cifra[] = plazo.meses === 0
        ? [{ valor: plazo.dias, unidad: T.dia(plazo.dias) }]
        : [
            { valor: plazo.meses, unidad: T.mes(plazo.meses) },
            ...(plazo.diasSueltos > 0 ? [{ valor: plazo.diasSueltos, unidad: T.dia(plazo.diasSueltos) }] : []),
          ];
      return {
        tipo: 'cuenta', cifras, titular: null, leyenda: T.paraTuDiploma, lecciones, enlace: enlaceNormal,
        frase: `${titularPlazo(plazo)} ${T.paraTuDiploma}`,
      };
    }
  }
}
