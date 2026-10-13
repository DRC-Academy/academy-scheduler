// Cambio de profesor desde el LMS (contrato v3: el alumno elige horarios, Gestión
// el profesor) con TODOS los planes de 1 a 5 horas semanales y TODAS las formas
// de repartirlas (3 h = 3, 2+1, 1+1+1; 4 h = 4, 3+1, 2+2, 2+1+1, 1+1+1+1; 5 h =
// 5, 4+1, 3+2, 3+1+1, 2+2+1, 2+1+1+1, 1+1+1+1+1), con el núcleo de transferencia
// de verdad sobre el cliente falso. Dos profesores destino: tB con todo libre de
// lunes a sábado y tC (calendario más reciente) solo los lunes. Para cada reparto:
//   · GET huecos-profesores paso a paso con `elegidos`: horarios para CADA
//     sesión, en orden, con su duración (2 h = 2 casillas contiguas libres en un
//     mismo profesor que también tiene libres los elegidos), sin solaparse ni ir
//     seguidos con los elegidos y sin ningún dato del profesor;
//   · POST cambiar-profesor: acepta si los destinos cubren todas las sesiones con
//     las mismas duraciones; si falta, sobra o no coincide una duración,
//     SESIONES_NO_COINCIDEN; si se solapan, DATOS_INVALIDOS. Sin escribir;
//   · elige tC si todo cae en lunes (lo tiene libre y su calendario es más
//     reciente) y tB si no; weekly_hours y slots suman las mismas horas, y el
//     calendario nuevo tiene las mismas sesiones (mismas duraciones).

import { describe, it, expect, vi } from 'vitest';
import type { Grid } from '@/types';
import { cambiarProfesorCore, type CambioProfesorParams, type DestinoProfesorDto } from '@/lib/cambioProfesor/core';
import { huecosEntreProfesores, chocan, type Horario } from '@/lib/cambioProfesor/huecos';
import { transferirAlumnoCore, type TransferenciaDeps } from '@/lib/transferencia/core';
import { CambioHorarioError } from '@/lib/cambioHorario/errors';
import { TransferenciaError } from '@/lib/transferencia/errors';
import { respuestaError } from '@/lib/cambioHorario/respuestas';
import { sesionesDelAlumno } from '@/lib/cambioHorario/sesiones';
import { clavesDeBloque } from '@/lib/huecos/huecos';
import { FakeDb } from '@/lib/transferencia/fakeDb.test-helper';
import { AHORA, hace } from '@/lib/cambioProfesor/fixtures.test-helper';

/** Todas las formas de repartir n horas en sesiones (particiones, de mayor a menor). */
function repartos(n: number, max = n): number[][] {
  if (n === 0) return [[]];
  const out: number[][] = [];
  for (let k = Math.min(n, max); k >= 1; k--) for (const resto of repartos(n - k, k)) out.push([k, ...resto]);
  return out;
}

const ALUMNA = 'Lucía Pérez';
const DIAS_ORIGEN = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'];
const DIAS_DESTINO = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

type Disposicion = 'días distintos' | 'mismo día';

/**
 * Calendario del profesor actual con las sesiones del reparto:
 *   · días distintos: una por día, de lunes a viernes, empezando a las 15:00;
 *   · mismo día: todas el martes, separadas por una hora libre, desde las 08:00.
 * El sábado 10/10 a las 10:00 (AHORA) todas quedan a más de 24 h.
 */
function gridOrigen(reparto: number[], disp: Disposicion): Grid {
  const g: Grid = {};
  let h = 8;
  reparto.forEach((dur, i) => {
    const dia = disp === 'días distintos' ? DIAS_ORIGEN[i] : 'Martes';
    const inicio = disp === 'días distintos' ? 15 : h;
    for (let k = 0; k < dur; k++) g[`${dia}_${hh(inicio + k)}`] = { state: 'ocupado', student: ALUMNA };
    h = inicio + dur + 1;
  });
  return g;
}

/** Profesor destino con todo libre de 09:00 a 21:00 en esos días. */
function gridDestino(dias = DIAS_DESTINO): Grid {
  const g: Grid = {};
  for (const d of dias) for (let h = 9; h <= 21; h++) g[`${d}_${hh(h)}`] = { state: 'libre' };
  return g;
}

const PLANES = ['Ingles General', 'Ingles Exámenes', 'Ingles Intensivo'];

function db(reparto: number[], disp: Disposicion, plan: string) {
  const horas = reparto.reduce((s, x) => s + x, 0);
  const origen = gridOrigen(reparto, disp);
  const slots = Object.keys(origen).map(k => ({ day: k.slice(0, k.lastIndexOf('_')), hour: k.slice(k.lastIndexOf('_') + 1) }));
  return new FakeDb({
    teachers: [
      { id: 'tA', name: 'Berta', email: 'berta@x.com', calendar_start_hour: 8, calendar_end_hour: 22 },
      { id: 'tB', name: 'Carla', email: 'carla@x.com', calendar_start_hour: 9, calendar_end_hour: 22 },
      { id: 'tC', name: 'Dani', email: 'dani@x.com', calendar_start_hour: 9, calendar_end_hour: 22 },
    ],
    teacher_calendars: [
      { teacher_id: 'tA', updated_at: hace(2), grid: origen },
      { teacher_id: 'tB', updated_at: hace(3), grid: gridDestino() },
      { teacher_id: 'tC', updated_at: hace(1), grid: gridDestino(['Lunes']) },
    ],
    calendar_changes: [],
    students: [{ id: 's1', name: ALUMNA, email: 'lucia@x.com', product_name: `${plan} - ${horas}h semanales`, company_plan_months: null, is_oritalk: false }],
    assignments: [{
      id: 'asg1', teacher_id: 'tA', teacher_name: 'Berta', teacher_email: 'berta@x.com', student_id: 's1', student_name: ALUMNA,
      student_email: 'lucia@x.com', status: 'active', weekly_hours: horas, plan: `${plan} - ${horas}h semanales`, start_date: '2026-09-01', slots,
    }],
    class_recoveries: [], notifications: [], class_records: [], scoring_events: [], transfer_requests: [],
  });
}

const deps = (): TransferenciaDeps => ({
  enviarEmailProfeNuevo: vi.fn(async () => true),
  enviarBienvenidaAlumno: vi.fn(async () => {}),
  ahora: () => AHORA,
});

const cambiar = (d: FakeDb, destinos: DestinoProfesorDto[]) => {
  const p: CambioProfesorParams = { studentId: 's1', destinos };
  return cambiarProfesorCore(d.client(), p, tp => transferirAlumnoCore(d.client(), tp, deps()), AHORA);
};

async function codigoDe(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) {
    return e instanceof CambioHorarioError || e instanceof TransferenciaError ? e.codigo : `otro: ${String(e)}`;
  }
}

const clavesDe = (x: { dia: string; hora: string; duracion: number }) => clavesDeBloque(x.dia, Number(x.hora.slice(0, 2)), x.duracion) ?? [];
const sinAuditoria = (d: FakeDb) => JSON.stringify({ ...d.tables, transfer_requests: undefined });

/** Todo lo que sale hacia el LMS: ningún id, nombre ni email de un profesor. */
function sinProfesores(d: FakeDb, r: unknown) {
  const json = JSON.stringify(r);
  expect(json).not.toMatch(/profesor|teacher/i);
  for (const t of d.rows('teachers')) for (const v of [t.id, t.name, t.email]) expect(json).not.toContain(String(v));
}

const CASOS = [1, 2, 3, 4, 5].flatMap(horas => repartos(horas).flatMap(reparto =>
  (['días distintos', 'mismo día'] as Disposicion[])
    .filter(disp => disp === 'días distintos' || reparto.length > 1)
    .map(disp => ({ horas, reparto, disp }))));

describe('cambio de profesor: todos los repartos de 1 a 5 h', () => {
  it('están todos los repartos pedidos', () => {
    expect(repartos(3).map(r => r.join('+'))).toEqual(['3', '2+1', '1+1+1']);
    expect(repartos(4).map(r => r.join('+'))).toEqual(['4', '3+1', '2+2', '2+1+1', '1+1+1+1']);
    expect(repartos(5).map(r => r.join('+'))).toEqual(['5', '4+1', '3+2', '3+1+1', '2+2+1', '2+1+1+1', '1+1+1+1+1']);
  });

  for (const { horas, reparto, disp } of CASOS) {
    for (const plan of PLANES) {
      it(`${horas} h = ${reparto.join('+')} (${disp}), ${plan}`, async () => {
        const d = db(reparto, disp, plan);
        const sesionesAntes = sesionesDelAlumno(d.grid('tA'), ALUMNA).map(s => s.duracion).sort();
        expect(sesionesAntes).toEqual([...reparto].sort());

        // ── huecos-profesores paso a paso, con los elegidos ───────────────
        const destinos: Horario[] = [];
        for (let i = 0; i < reparto.length; i++) {
          const r = await huecosEntreProfesores({ client: d.client(), alumno: 's1', elegidos: destinos, ahora: AHORA });
          sinProfesores(d, r);
          expect(r.sesiones.map(s => s.duracion)).toEqual(reparto);
          expect(r.siguiente).toEqual({ indice: i, duracion: reparto[i] });
          expect(r.elegidos_disponibles).toBe(true);
          expect(r.horarios.length, `sin horarios para la sesión ${i + 1} de ${reparto[i]} h`).toBeGreaterThan(0);
          const claves = new Set<string>();
          for (const h of r.horarios) {
            expect(h.duracion).toBe(reparto[i]);
            expect(clavesDe(h)).toHaveLength(reparto[i]);   // N casillas contiguas
            // Libre en un profesor que también tiene libres todos los elegidos.
            const enAlguno = ['tB', 'tC'].some(t => [...destinos, h].every(x => clavesDe(x).every(k => d.grid(t)[k]?.state === 'libre')));
            expect(enAlguno, `${h.dia} ${h.hora}`).toBe(true);
            expect(destinos.some(e => chocan(e, h)), `${h.dia} ${h.hora} choca con un elegido`).toBe(false);
            const k = `${h.dia} ${h.hora}`;
            expect(claves.has(k), `repetido: ${k}`).toBe(false);
            claves.add(k);
          }
          destinos.push({ dia: r.horarios[0].dia, hora: r.horarios[0].hora, duracion: r.horarios[0].duracion });
        }
        const fin = await huecosEntreProfesores({ client: d.client(), alumno: 's1', elegidos: destinos, ahora: AHORA });
        expect(fin).toMatchObject({ siguiente: null, elegidos_disponibles: true, horarios: [] });

        // ── rechazos: nada se escribe ──────────────────────────────────────
        const antes = sinAuditoria(d);
        const extra = { dia: 'Sábado', hora: '20:00', duracion: 1 };
        const rechazos: Array<[string, DestinoProfesorDto[], string]> = [
          ['falta una sesión', destinos.slice(1), 'SESIONES_NO_COINCIDEN'],
          ['sobra una sesión', [...destinos, extra], 'SESIONES_NO_COINCIDEN'],
          ['una duración no coincide', destinos.map((x, i) => (i === 0 ? { dia: 'Sábado', hora: '09:00', duracion: x.duracion === 1 ? 2 : x.duracion - 1 } : x)), 'SESIONES_NO_COINCIDEN'],
        ];
        if (destinos.length > 1) {
          // Mismas duraciones, pero la segunda encima de la primera.
          rechazos.push(['dos destinos se solapan', destinos.map((x, i) => (i === 1 ? { ...x, dia: destinos[0].dia, hora: destinos[0].hora } : x)), 'DATOS_INVALIDOS']);
        }
        for (const [que, ds, codigo] of rechazos) {
          expect(await codigoDe(cambiar(d, ds)), que).toBe(codigo);
          expect(sinAuditoria(d), `${que}: no escribe nada`).toBe(antes);
        }

        // ── el cambio ──────────────────────────────────────────────────────
        const res = await cambiar(d, destinos);
        const esperado = destinos.every(x => x.dia === 'Lunes') ? 'tC' : 'tB';
        expect(res.a.id).toBe(esperado);
        const asg = d.rows('assignments')[0];
        expect(asg.teacher_id).toBe(esperado);
        expect(asg.weekly_hours).toBe(horas);
        expect((asg.slots as unknown[]).length).toBe(horas);
        expect(res.slotsDespues).toHaveLength(horas);
        // El calendario nuevo tiene las mismas sesiones; el viejo, ninguna.
        expect(sesionesDelAlumno(d.grid(esperado), ALUMNA).map(s => s.duracion).sort()).toEqual([...reparto].sort());
        expect(sesionesDelAlumno(d.grid('tA'), ALUMNA)).toEqual([]);
      });
    }
  }
});

describe('cambio de profesor: SESIONES_NO_COINCIDEN en la respuesta HTTP', () => {
  it('422 con su código y un mensaje que dice qué hacer', async () => {
    const d = db([2, 1], 'días distintos', 'Ingles General');
    const err = await cambiar(d, [{ dia: 'Lunes', hora: '10:00', duracion: 2 }]).catch(e => e);
    const http = respuestaError(err, 't');
    expect(http.status).toBe(422);
    const cuerpo = await http.json();
    expect(cuerpo).toMatchObject({ ok: false, codigo: 'SESIONES_NO_COINCIDEN' });
    expect(cuerpo.mensaje).toMatch(/cada una de tus clases/);
  });

  it('sin destinos (lista vacía) también es SESIONES_NO_COINCIDEN', async () => {
    expect(await codigoDe(cambiar(db([1], 'días distintos', 'Ingles General'), []))).toBe('SESIONES_NO_COINCIDEN');
  });
});

describe('cambio de profesor: planes que el autoservicio no cubre', () => {
  const casos: Array<[string, (d: FakeDb) => void, string]> = [
    ['empresa', d => { d.rows('students')[0].product_name = 'Plan Empresa - 3h semanales'; }, 'EMPRESA'],
    ['oritalk', d => { d.rows('students')[0].is_oritalk = true; }, 'ORITALK'],
    ['dos alumnos', d => { d.rows('students')[0].product_name = 'Ingles general dos alumnos - 3h semanales'; }, 'PLAN_DOS_ALUMNOS'],
  ];
  for (const [plan, prep, detalle] of casos) {
    it(`${plan}: NO_ELEGIBLE (${detalle}), sin escribir nada`, async () => {
      const d = db([2, 1], 'días distintos', 'Ingles General'); prep(d);
      const antes = sinAuditoria(d);
      const err = await cambiar(d, [{ dia: 'Lunes', hora: '10:00', duracion: 2 }, { dia: 'Miércoles', hora: '18:00', duracion: 1 }]).catch(e => e);
      expect(err).toMatchObject({ codigo: 'NO_ELEGIBLE', detalleNoElegible: detalle });
      expect(sinAuditoria(d)).toBe(antes);
    });
  }
});
