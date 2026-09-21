// Qué enseña el banner del diploma en cada estado. Con fechas fijas: "hoy" y
// los singulares ("1 MES", "1 DÍA") no tienen alumno real que los enseñe.

import { describe, it, expect } from 'vitest';
import { bannerDe, T, type Banner } from './diplomaCalendario';
import type { Diploma } from './diplomaTypes';

const enCurso: Diploma = { estado: 'en-curso', completadas: 38, total: 168, restantes: 130, curso: { slug: 'b1', titulo: 'B1' } };
const cero: Diploma = { estado: 'en-curso', completadas: 0, total: 168, restantes: 168, curso: { slug: 'b1', titulo: 'B1' } };
const conseguido: Diploma = { estado: 'conseguido', completadas: 187, total: 187, restantes: 0, curso: { slug: 'a2', titulo: 'A2' } };
const sinCurso: Diploma = { estado: 'sin-curso', completadas: 0, total: 0, restantes: 0, curso: null };

/** Solo lo que se lee en las cifras: "5 Meses · 21 Días". */
const cifras = (b: Banner | null) => (b ? b.cifras.map(c => `${c.valor} ${c.unidad}`).join(' · ') : '(sin banner)');

describe('bannerDe — meses y días', () => {
  it('más de 30 días: dos cifras, meses y días de calendario', () => {
    // Inicio 31/08/2026 → diploma 28/02/2027; desde el 18/09/2026: 5 meses y 10 días.
    const b = bannerDe(enCurso, '2026-08-31', '2026-09-18')!;
    expect(b.tipo).toBe('cuenta');
    expect(cifras(b)).toBe('5 Meses · 10 Días');
    expect(b.titular).toBeNull();
    expect(b.leyenda).toBe(T.paraTuDiploma);
    expect(b.lecciones).toBe('38 de 168 lecciones');
    expect(b.enlace).toBe(T.irALaPlataforma);
    expect(b.frase).toBe('Te quedan 5 meses y 10 días para tu diploma');
  });

  it('días sueltos a cero: solo la cifra de los meses', () => {
    // Inicio 18/06/2026 → diploma 18/12/2026; desde el 18/09/2026: 3 meses justos.
    expect(cifras(bannerDe(enCurso, '2026-06-18', '2026-09-18'))).toBe('3 Meses');
  });

  it('singular: 1 MES y 1 DÍA', () => {
    // Diploma 19/10/2026 desde el 18/09/2026: 1 mes y 1 día.
    const b = bannerDe(enCurso, '2026-04-19', '2026-09-18')!;
    expect(cifras(b)).toBe('1 Mes · 1 Día');
    expect(b.frase).toContain('Te quedan 1 mes y 1 día para tu diploma');
  });

  it('plural del mes con singular del día y viceversa', () => {
    expect(cifras(bannerDe(enCurso, '2026-04-27', '2026-09-18'))).toBe('1 Mes · 9 Días');   // diploma 27/10
    expect(cifras(bannerDe(enCurso, '2026-05-19', '2026-09-18'))).toBe('2 Meses · 1 Día');  // diploma 19/11
  });

  it('menos de 31 días: una sola cifra con los días', () => {
    const b = bannerDe(enCurso, '2026-04-13', '2026-09-18')!; // diploma 13/10 → 25 días
    expect(cifras(b)).toBe('25 Días');
    expect(b.frase).toBe('Te quedan 25 días para tu diploma');
  });

  it('última semana y singular del día', () => {
    expect(cifras(bannerDe(enCurso, '2026-03-25', '2026-09-18'))).toBe('7 Días');
    const uno = bannerDe(enCurso, '2026-03-19', '2026-09-18')!;
    expect(cifras(uno)).toBe('1 Día');
    expect(uno.frase).toContain('¡Última semana! Te queda 1 día para tu diploma');
  });
});

describe('bannerDe — los otros estados', () => {
  it('hoy: la palabra HOY donde van las cifras y "es el día de tu diploma"', () => {
    const b = bannerDe(enCurso, '2026-03-18', '2026-09-18')!;
    expect(b.tipo).toBe('hoy');
    expect(b.cifras).toEqual([]);
    expect(b.titular).toBe(T.hoy);
    expect(b.leyenda).toBe(T.esElDiaDeTuDiploma);
    expect(b.frase).toBe(T.tuDiplomaEsHoy);
    expect(b.enlace).toBe(T.irALaPlataforma);
  });

  it('vencido: titular de retoma, sin cifras ni leyenda, y el botón cambia a Continuar mi curso', () => {
    const b = bannerDe(enCurso, '2025-09-16', '2026-09-18')!;
    expect(b.tipo).toBe('vencido');
    expect(b.cifras).toEqual([]);
    expect(b.titular).toBe(T.retomaTuCurso);
    expect(b.titularCorto).toBe(T.retomaTuCursoCorto);
    expect(b.leyenda).toBeNull();
    expect(b.lecciones).toBe('38 de 168 lecciones');
    expect(b.enlace).toBe(T.continuarMiCurso);
    expect(b.frase).toBeNull();
    // Con cero lecciones sigue siendo "Continuar": el titular ya dice "Retoma".
    expect(bannerDe(cero, '2025-09-16', '2026-09-18')!.enlace).toBe(T.continuarMiCurso);
  });

  it('conseguido manda sobre la fecha, aunque el plazo esté vencido, en curso o no exista', () => {
    for (const inicio of ['2025-09-16', '2026-08-31', null]) {
      const b = bannerDe(conseguido, inicio, '2026-09-18')!;
      expect(b.tipo).toBe('conseguido');
      expect(b.titular).toBe(T.diplomaConseguido);
      expect(b.titularCorto).toBeNull();
      expect(b.leyenda).toBeNull();
      expect(b.lecciones).toBe('187 de 187 lecciones');
      expect(b.enlace).toBe(T.verMiCurso);
      expect(b.frase).toBeNull();
    }
  });

  it('sin fecha de inicio (o una que no es fecha): el banner no se muestra', () => {
    for (const inicio of [null, '', 'ayer', '2026-02-30']) {
      expect(bannerDe(enCurso, inicio, '2026-09-18')).toBeNull();
      expect(bannerDe(cero, inicio, '2026-09-18')).toBeNull();
      expect(bannerDe(null, inicio, '2026-09-18')).toBeNull();
    }
  });
});

describe('bannerDe — lo que pone el LMS', () => {
  it('cero lecciones con curso: el botón pasa a Empezar mi curso', () => {
    expect(bannerDe(cero, '2026-08-31', '2026-09-18')!.enlace).toBe(T.empezarMiCurso);
    expect(bannerDe(cero, '2026-04-13', '2026-09-18')!.enlace).toBe(T.empezarMiCurso);
    expect(bannerDe(cero, '2026-03-18', '2026-09-18')!.enlace).toBe(T.empezarMiCurso);  // hoy
    expect(bannerDe(cero, '2026-08-31', '2026-09-18')!.lecciones).toBe('0 de 168 lecciones');
  });

  it("'cargando', null y sin curso: cuenta por fecha, sin línea de lecciones, botón normal", () => {
    for (const diploma of ['cargando' as const, null, sinCurso]) {
      const b = bannerDe(diploma, '2026-08-31', '2026-09-18')!;
      expect(cifras(b)).toBe('5 Meses · 10 Días');
      expect(b.lecciones).toBeNull();
      expect(b.enlace).toBe(T.irALaPlataforma);
      expect(b.frase).toBe('Te quedan 5 meses y 10 días para tu diploma');
    }
  });
});
