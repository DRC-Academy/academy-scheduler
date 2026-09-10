// El cálculo del banner de ampliación.
//
// Tres cosas que fijan estos tests y que no pueden cambiar sin querer:
//   · `mesesPara`: el plazo sale del horizonte FIJO (84 h), no del salto entre
//     niveles. Es lo que hace que la promesa sea predecible.
//   · la detección de meta: qué cuenta como examen y en qué orden se miran las
//     fuentes. Aquí se pierden alumnos con mucha facilidad.
//   · los cuatro estados, con su precedencia.

import { describe, expect, it } from 'vitest';
import {
  mesesPara, etiquetaMeses, etiquetaHoras, etiquetaLlegada,
  examenEnTexto, detectarMeta, construirEstimacion, estadoDeBanner,
  HORAS_OBJETIVO, HORAS_SEMANALES_MAXIMAS,
} from './estimacion';

const AHORA = new Date('2026-09-09T00:00:00Z');

describe('mesesPara — el horizonte es fijo', () => {
  // 84 h guiadas / (horas * 1.5 * 4 semanas)
  it('2 h a la semana → 7 meses', () => expect(mesesPara(2)).toBe(7));
  it('1 h a la semana → 14 meses', () => expect(mesesPara(1)).toBe(14));
  it('3 h a la semana → 5 meses', () => expect(mesesPara(3)).toBe(5));
  it('4 h a la semana → 4 meses', () => expect(mesesPara(4)).toBe(4));
  it('5 h a la semana → 3 meses', () => expect(mesesPara(5)).toBe(3));

  it('nunca devuelve 0: "llegarías en 0 meses" no significa nada', () => {
    expect(mesesPara(40)).toBe(1);
  });

  it('sin horas devuelve 0 (no hay plan que estimar)', () => {
    expect(mesesPara(0)).toBe(0);
    expect(mesesPara(-2)).toBe(0);
    expect(mesesPara(NaN)).toBe(0);
  });

  it('NO depende del nivel: el mismo plan da el mismo plazo siempre', () => {
    // Es la diferencia con el modelo viejo (horas de Cambridge por nivel), donde
    // un A2 veía 7 meses y un B1 quince por el mismo esfuerzo.
    const a2 = construirEstimacion({ nivelActual: 'A2', horasSemanales: 2, fuentes: {}, ahora: AHORA });
    const c1 = construirEstimacion({ nivelActual: 'C1', horasSemanales: 2, fuentes: {}, ahora: AHORA });
    expect(a2?.opciones[0].meses).toBe(c1?.opciones[0].meses);
  });
});

describe('etiquetas', () => {
  it('singular y plural', () => {
    expect(etiquetaMeses(1)).toBe('1 mes');
    expect(etiquetaMeses(7)).toBe('7 meses');
    expect(etiquetaHoras(1)).toBe('1 hora a la semana');
    expect(etiquetaHoras(3)).toBe('3 horas a la semana');
  });

  it('la llegada se calcula en UTC (el día 1 no salta de mes)', () => {
    expect(etiquetaLlegada(7, new Date('2026-09-09T23:30:00Z'))).toBe('abril de 2027');
  });
});

describe('examenEnTexto — qué cuenta como examen', () => {
  it('reconoce los exámenes de Cambridge por su nombre', () => {
    expect(examenEnTexto('Preparación C2 Proficiency')).toBe('C2');
    expect(examenEnTexto('Preparación C1 Advanced - 2h semanales')).toBe('C1');
    expect(examenEnTexto('Preparación B2 First Certificate')).toBe('B2');
    expect(examenEnTexto('Preparación B1 Preliminary - 2h semanales')).toBe('B1');
  });

  it('IELTS y TOEFL cuentan como B2', () => {
    expect(examenEnTexto('Preparación IELTS')).toBe('B2');
    expect(examenEnTexto('curso TOEFL intensivo')).toBe('B2');
  });

  it('CAE y PET solo en MAYÚSCULAS: son palabras españolas corrientes', () => {
    expect(examenEnTexto('intensivo PET — 17 pm')).toBe('B1');
    expect(examenEnTexto('preparación CAE')).toBe('C1');
    // "cae" en minúsculas es el verbo, no el examen.
    expect(examenEnTexto('el horario que mejor le cae')).toBeNull();
    expect(examenEnTexto('trae al pet de casa')).toBeNull();
  });

  it('un código MCER suelto NO es un examen', () => {
    // Es el nivel al que ya da clase, no su meta.
    expect(examenEnTexto('Curso de inglés general - 2h semanales, B2')).toBeNull();
    expect(examenEnTexto('Inglés general')).toBeNull();
    expect(examenEnTexto('B1')).toBeNull();
  });

  it('un código MCER CON palabra de examen sí lo es', () => {
    expect(examenEnTexto('B2 Exámenes')).toBe('B2');
    expect(examenEnTexto('B1 Exámenes Intensivo')).toBe('B1');
    expect(examenEnTexto('Preparación B1')).toBe('B1');
  });

  it('dos códigos con palabra de examen: ambiguo, no se adivina', () => {
    expect(examenEnTexto('B1 Exámenes, objetivo C1')).toBeNull();
  });

  it('texto vacío o nulo', () => {
    expect(examenEnTexto('')).toBeNull();
    expect(examenEnTexto(null)).toBeNull();
    expect(examenEnTexto(undefined)).toBeNull();
  });
});

describe('detectarMeta — orden de las fuentes', () => {
  it('gana el producto de WooCommerce sobre todo lo demás', () => {
    const m = detectarMeta({
      productoWoo: 'Preparación C1 Advanced - 2h semanales',
      planAssignment: 'B2 Exámenes',
      objetivo: 'Preparación B1',
    }, 'B1');
    expect(m).toMatchObject({ nivel: 'C1', origen: 'examen', fuente: 'producto' });
  });

  it('si el producto no dice examen, sigue por el plan del alumno', () => {
    const m = detectarMeta({
      productoWoo: 'Curso de inglés general - 2h semanales',
      planAlumno: 'B2 Exámenes',
    }, 'B1');
    expect(m).toMatchObject({ nivel: 'B2', fuente: 'plan_alumno' });
  });

  it('llega hasta el objetivo personal de la ficha si hace falta', () => {
    const m = detectarMeta({
      productoWoo: 'Inglés general', planAssignment: 'Inglés general',
      objetivoPersonal: 'Quiero sacarme el First',
    }, 'B1');
    expect(m).toMatchObject({ nivel: 'B2', fuente: 'objetivo_personal' });
  });

  it('sin examen en ningún sitio, la meta es el siguiente peldaño', () => {
    expect(detectarMeta({ productoWoo: 'Inglés general' }, 'B1'))
      .toEqual({ nivel: 'B2', origen: 'siguiente_nivel' });
  });

  it('ya está EN el nivel del examen: no hay meta (ni banner)', () => {
    // Un "B1" preparando el PET. Su meta es aprobarlo, no subir al B2.
    expect(detectarMeta({ productoWoo: 'intensivo PET' }, 'B1')).toBeNull();
  });

  it('un examen POR DEBAJO de su nivel es incoherente: manda la escalera', () => {
    // Un C1 apuntado al First.
    expect(detectarMeta({ productoWoo: 'Preparación B2 First Certificate' }, 'C1'))
      .toEqual({ nivel: 'C2', origen: 'siguiente_nivel' });
  });

  it('en C2 no hay nada por encima', () => {
    expect(detectarMeta({}, 'C2')).toBeNull();
  });
});

// ── Los cuatro estados ───────────────────────────────────────────────────────

const entrada = (o: Partial<Parameters<typeof construirEstimacion>[0]> = {}) => ({
  nivelActual: 'B1', horasSemanales: 2, fuentes: {}, ahora: AHORA, ...o,
});

describe('los cuatro estados del banner', () => {
  it('AHORRO: plan normal con margen para ampliar', () => {
    const e = construirEstimacion(entrada());
    expect(e?.estado).toBe('ahorro');
    expect(e?.hayAmpliacion).toBe(true);
    expect(e?.opciones.map(o => o.horasSemanales)).toEqual([2, 3, 4]);
    expect(e?.opciones[0].mesesAhorrados).toBe(0);
    // 7 meses a 2 h, 4 a 4 h → 3 de ahorro.
    expect(e?.mejor?.mesesAhorrados).toBe(3);
  });

  it('TOPE: ya está en el plan más alto', () => {
    const e = construirEstimacion(entrada({ horasSemanales: HORAS_SEMANALES_MAXIMAS }));
    expect(e?.estado).toBe('tope');
    expect(e?.hayAmpliacion).toBe(false);
    expect(e?.opciones).toHaveLength(1);
    expect(e?.mejor).toBeNull();
  });

  it('TOPE también por encima del techo (un plan de 6 h)', () => {
    const e = construirEstimacion(entrada({ horasSemanales: 6 }));
    expect(e?.estado).toBe('tope');
  });

  it('EXAMEN: la meta es un examen concreto', () => {
    const e = construirEstimacion(entrada({
      nivelActual: 'A2', fuentes: { productoWoo: 'Preparación B2 First Certificate - 2h semanales' },
    }));
    expect(e?.estado).toBe('examen');
    expect(e?.meta).toMatchObject({ nivel: 'B2', origen: 'examen' });
  });

  it('EXAMEN cede ante TOPE: sin ampliación que ofrecer no hay nada que vender', () => {
    const e = construirEstimacion(entrada({
      nivelActual: 'A2', horasSemanales: 5,
      fuentes: { productoWoo: 'Preparación B2 First Certificate' },
    }));
    expect(e?.estado).toBe('tope');
  });

  it('SIN DATOS: sin nivel reconocible', () => {
    expect(construirEstimacion(entrada({ nivelActual: 'Inglés general' }))).toBeNull();
    expect(construirEstimacion(entrada({ nivelActual: null }))).toBeNull();
    expect(estadoDeBanner(entrada({ nivelActual: null }))).toBe('sin_datos');
  });

  it('SIN DATOS: sin horas del plan', () => {
    expect(construirEstimacion(entrada({ horasSemanales: 0 }))).toBeNull();
    expect(construirEstimacion(entrada({ horasSemanales: null }))).toBeNull();
    expect(estadoDeBanner(entrada({ horasSemanales: null }))).toBe('sin_datos');
  });

  it('SIN DATOS: ya está en C2, o ya está en el nivel de su examen', () => {
    expect(estadoDeBanner(entrada({ nivelActual: 'C2' }))).toBe('sin_datos');
    expect(estadoDeBanner(entrada({ fuentes: { productoWoo: 'intensivo PET' } }))).toBe('sin_datos');
  });
});

describe('las opciones del plan', () => {
  it('la barra más lenta vale 100 y las demás son proporcionales', () => {
    const e = construirEstimacion(entrada());
    expect(e?.opciones[0].anchoPct).toBe(100);
    expect(e?.opciones[1].anchoPct).toBeLessThan(100);
  });

  it('ninguna barra baja del 12%: tres píxeles no se leen como una barra', () => {
    const e = construirEstimacion(entrada({ horasSemanales: 1 }));
    for (const o of e?.opciones ?? []) expect(o.anchoPct).toBeGreaterThanOrEqual(12);
  });

  it('las ampliaciones nunca pasan del techo', () => {
    const e = construirEstimacion(entrada({ horasSemanales: 4 }));
    expect(e?.opciones.map(o => o.horasSemanales)).toEqual([4, 5]);
  });

  it('el horizonte que se muestra es la constante', () => {
    expect(construirEstimacion(entrada())?.horasObjetivo).toBe(HORAS_OBJETIVO);
  });
});
