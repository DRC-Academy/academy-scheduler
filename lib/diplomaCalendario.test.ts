// Qué hojas enseña el calendario del diploma en cada estado. Con fechas fijas:
// "hoy" y los singulares ("1 MES", "1 DÍA") no tienen alumno real que los enseñe.

import { describe, it, expect } from 'vitest';
import { dibujoDe, T } from './diplomaCalendario';
import type { Diploma } from './diplomaTypes';

const enCurso: Diploma = { estado: 'en-curso', completadas: 60, total: 182, restantes: 122, curso: { slug: 'b1', titulo: 'B1' } };
const conseguido: Diploma = { estado: 'conseguido', completadas: 187, total: 187, restantes: 0, curso: { slug: 'a2', titulo: 'A2' } };
const sinCurso: Diploma = { estado: 'sin-curso', completadas: 0, total: 0, restantes: 0, curso: null };

/** Solo lo que se lee en las hojas: "5 Meses · 21 Días". */
const hojas = (d: ReturnType<typeof dibujoDe>) => d.hojas.map(h => (h.sello ? `✓ ${h.rotulo}` : `${h.valor} ${h.rotulo}`)).join(' · ');

describe('dibujoDe — meses y días', () => {
  it('más de 30 días: dos hojas, meses y días de calendario', () => {
    // Inicio 31/08/2026 → diploma 28/02/2027; desde el 18/09/2026: 5 meses y 10 días.
    const d = dibujoDe(enCurso, '2026-08-31', '2026-09-18');
    expect(hojas(d)).toBe('5 Meses · 10 Días');
    expect(d.leyenda).toBe(T.paraTuDiploma);
    expect(d.enlace).toBe(T.irALaPlataforma);
    expect(d.frase).toBe('Te quedan 5 meses y 10 días para tu diploma');
  });

  it('días sueltos a cero: solo la hoja de los meses', () => {
    // Inicio 18/06/2026 → diploma 18/12/2026; desde el 18/09/2026: 3 meses justos.
    const d = dibujoDe(enCurso, '2026-06-18', '2026-09-18');
    expect(hojas(d)).toBe('3 Meses');
    expect(d.frase).toBe('Te quedan 3 meses para tu diploma');
  });

  it('singular: 1 MES y 1 DÍA', () => {
    // Diploma 19/10/2026 desde el 18/09/2026: 1 mes y 1 día.
    const d = dibujoDe(enCurso, '2026-04-19', '2026-09-18');
    expect(hojas(d)).toBe('1 Mes · 1 Día');
    expect(d.frase).toBe('Te quedan 1 mes y 1 día para tu diploma');
  });

  it('menos de 31 días: una sola hoja con los días', () => {
    const d = dibujoDe(enCurso, '2026-04-13', '2026-09-18'); // diploma 13/10 → 25 días
    expect(hojas(d)).toBe('25 Días');
    expect(d.frase).toBe('Te quedan 25 días para tu diploma');
  });

  it('última semana y singular del día', () => {
    expect(hojas(dibujoDe(enCurso, '2026-03-25', '2026-09-18'))).toBe('7 Días');
    const uno = dibujoDe(enCurso, '2026-03-19', '2026-09-18');
    expect(hojas(uno)).toBe('1 Día');
    expect(uno.frase).toBe('¡Última semana! Te queda 1 día para tu diploma');
  });
});

describe('dibujoDe — los otros estados', () => {
  it('hoy: la hoja HOY con el rótulo DIPLOMA', () => {
    const d = dibujoDe(enCurso, '2026-03-18', '2026-09-18');
    expect(hojas(d)).toBe('Hoy Diploma');
    expect(d.hojas[0].corta).toBe(true);
    expect(d.leyenda).toBe(T.tuDiplomaEsHoy);
    expect(d.enlace).toBe(T.irALaPlataforma);
  });

  it('vencido: ¡Retoma! / TU CURSO y el enlace cambia a Continuar mi curso', () => {
    const d = dibujoDe(enCurso, '2025-09-16', '2026-09-18');
    expect(hojas(d)).toBe('¡Retoma! Tu curso');
    expect(d.hojas[0].palabra).toBe(true);
    expect(d.leyenda).toBe(T.yConsigueTuDiploma);
    expect(d.enlace).toBe(T.continuarMiCurso);
  });

  it('conseguido manda sobre la fecha, aunque el plazo esté vencido o en curso', () => {
    for (const inicio of ['2025-09-16', '2026-08-31', null]) {
      const d = dibujoDe(conseguido, inicio, '2026-09-18');
      expect(hojas(d)).toBe('✓ Diploma');
      expect(d.leyenda).toBe(T.cursoCompletado);
      expect(d.enlace).toBe(T.irALaPlataforma);
      expect(d.frase).toBe(T.diplomaConseguido);
    }
  });

  it('sin fecha de inicio (o una que no es fecha): sin hojas, solo el enlace', () => {
    for (const inicio of [null, '', 'ayer', '2026-02-30']) {
      const d = dibujoDe(enCurso, inicio, '2026-09-18');
      expect(d.hojas).toEqual([]);
      expect(d.leyenda).toBeNull();
      expect(d.frase).toBeNull();
      expect(d.enlace).toBe(T.irALaPlataforma);
    }
  });

  it("'cargando', null y sin curso en el LMS enseñan la cuenta por fecha igual", () => {
    for (const diploma of ['cargando' as const, null, sinCurso]) {
      expect(hojas(dibujoDe(diploma, '2026-08-31', '2026-09-18'))).toBe('5 Meses · 10 Días');
    }
  });
});
