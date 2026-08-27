// ── Embudo de clases del mes ─────────────────────────────────────────────────
//
// POR QUÉ EXISTE. Las tarjetas de Finanzas contaban cada una por su cuenta: la de
// "Sin ingreso detectado" miraba `class_records` sin ingreso cercano (o sea, solo
// las clases que el profesor había registrado a mano) mientras /revisiones
// proyectaba el calendario entero. Poblaciones distintas contando cosas distintas
// con etiquetas parecidas: Agustin veía 19 en una pantalla y 42 en la otra, las
// dos "correctas", y no había forma de saber cuál mirar.
//
// LA REGLA. Cada clase del mes está en EXACTAMENTE UNA rama, y el total es la
// suma de las ramas. Si no suma, hay un bug — y `funnelIsConsistent` lo dice en
// vez de dejar que el número mienta.
//
//   Clases del mes
//     ├── Con registro de clase           (clic en "Ingresar", o constancia)
//     │     ├── Pagables                  → suman al total del mes
//     │     └── Pendientes de cobro       → dadas, sin cobrar todavía
//     ├── Sin ingreso registrado          (el calendario dice que tocaba)
//     │     ├── Reclamables               → hay transcript: se piden en Revisiones
//     │     └── Sin transcript ni registro→ no hay nada que reclamar
//     └── Fuera del calendario            (hecho real sin celda agendada)
//
// "Fuera del calendario" no es un cajón de sastre: son recuperaciones, clases
// añadidas a mano y alumnos que cambiaron de horario. Sin esa rama el total
// mentiría, porque esas clases existen, se cobran, y no salen de ninguna celda.
//
// TODO se mide en CLASES (unidades), no en filas: una sesión de 2 horas cuenta 2
// en todas las ramas, igual que en el pago. Así "Pagables" del embudo y
// `totalPagable` de finanzas son el mismo número y no hay que explicar por qué
// difieren.

import type { Assignment, ClassJoinLog, ClassRecord, ClassReviewRequest } from '@/types';
import type { ClassTranscriptRef, TeacherFinanceResult, ClassFinanceRow } from '@/lib/finance';
import type { GridOccupancy } from '@/lib/teacherClasses';
import { buildMissingJoinClasses, type MissingJoinClass } from '@/lib/reviewRequests';
import { periodIndex, existsForStudent, type StudentDropout } from '@/lib/studentPeriod';

const nk = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/** Una rama del embudo. `amount` solo donde el dinero significa algo. */
export interface FunnelBranch {
  key: string;
  label: string;
  /** Clases (unidades): una sesión de 2h cuenta 2. */
  count: number;
  amount?: number;
  /** Ramas hijas. La suma de sus `count` es el `count` del padre. */
  children?: FunnelBranch[];
  /** Ayuda contextual de una línea. */
  hint?: string;
  /**
   * Las filas de finanzas que componen esta rama. SOLO para que la pantalla
   * pueda llevar al detalle al hacer clic: la clasificación se hace acá y en
   * ningún otro sitio, así que nadie tiene que volver a decidir qué clase
   * pertenece a qué rama para pintarla. No participa de ningún cálculo — ni
   * `count`, ni `amount`, ni `funnelIsConsistent` la miran.
   *
   * Ausente en las ramas que no salen de finanzas (las de "sin ingreso" viven
   * en `ClassFunnel.missing`).
   */
  rows?: ClassFinanceRow[];
  /**
   * Desglose de "Pendientes de cobro" en sus DOS causas, que no son lo mismo:
   *
   *   · `transcript` → depende del profesor: sube el archivo y cobra.
   *   · `limite`     → no depende de nadie: la clase excede el cupo mensual del
   *                    alumno y la resuelve el equipo.
   *
   * La rama sigue siendo UNA (partirla cambiaría la forma del embudo), pero
   * pedirle "subí el transcript" a alguien cuyas clases están retenidas por un
   * límite es mandarlo a hacer algo que no sirve. Con esto la pantalla puede
   * decir cuántas son de cada tipo sin inventar el dato.
   *
   * PENDIENTE (septiembre): separarlas en dos ramas de verdad.
   */
  pendingSplit?: { transcript: number; limite: number };
}

export interface ClassFunnel {
  monthYear: string;
  /** Suma exacta de las ramas de primer nivel. */
  total: number;
  branches: FunnelBranch[];
  /** Las clases sin ingreso, para el detalle al hacer clic. */
  missing: MissingJoinClass[];
}

/**
 * ¿Cuadra el embudo? Debería ser SIEMPRE true; se expone para poder afirmarlo en
 * pantalla en vez de suponerlo. Un total que no es la suma de sus partes es un
 * bug, y prefiero verlo a que pase inadvertido.
 */
export function funnelIsConsistent(f: ClassFunnel): boolean {
  const suma = f.branches.reduce((s, b) => s + b.count, 0);
  if (suma !== f.total) return false;
  return f.branches.every(b =>
    !b.children?.length || b.children.reduce((s, c) => s + c.count, 0) === b.count);
}

const inMonth = (d: string | undefined, my: string) => (d ?? '').slice(0, 7) === my;

/**
 * Arma el embudo del mes de UN profesor.
 *
 * Todo sale de las mismas fuentes que las pantallas que ya existen:
 *   · `finance` — `calculateTeacherFinance`, tal cual, sin recalcular nada. De
 *     ahí salen pagables, pendientes y los importes. NO se le aplica el período
 *     (ver el contrato de lib/studentPeriod): son hechos, no proyecciones.
 *   · `buildMissingJoinClasses` — la misma función que /revisiones, con el mismo
 *     filtro de período, para que el número del embudo y el de la pantalla no
 *     puedan separarse.
 */
export function buildClassFunnel(opts: {
  monthYear: string;
  teacherId: string;
  /** Del CALENDARIO (`getTeacherAssignments`), no de la ficha. */
  assignments: Assignment[];
  joinLogs: ClassJoinLog[];
  classRecords: ClassRecord[];
  analyses: ClassTranscriptRef[];
  requests: ClassReviewRequest[];
  dropouts: StudentDropout[];
  gridOccupancy: GridOccupancy;
  finance: TeacherFinanceResult;
  todayIso: string;
  nowMinutes: number;
}): ClassFunnel {
  const { monthYear, teacherId, finance } = opts;
  const [y, m] = monthYear.split('-').map(Number);
  const ultimo = new Date(y, m, 0).getDate();

  // ── Sin ingreso: la MISMA llamada que hace /revisiones ────────────────────
  const missing = buildMissingJoinClasses({
    assignments: opts.assignments,
    joinLogs: opts.joinLogs,
    classRecords: opts.classRecords,
    requests: opts.requests,
    analyses: opts.analyses,
    dropouts: opts.dropouts,
    teacherId,
    fromDate: `${monthYear}-01`,
    toDate: `${monthYear}-${String(ultimo).padStart(2, '0')}`,
    todayIso: opts.todayIso,
    nowMinutes: opts.nowMinutes,
    gridOccupancy: opts.gridOccupancy,
    // El embudo cuenta TODO lo que el calendario dice que tocaba, con rastro o
    // sin él: la rama "sin transcript ni registro" es justamente esa diferencia.
    onlyWithSignal: false,
  });

  const unidades = (list: MissingJoinClass[]) => list.reduce((s, c) => s + (c.durationHours || 1), 0);
  const reclamables = missing.filter(c => c.signal !== null);
  const sinRastro   = missing.filter(c => c.signal === null);

  // ── Los HECHOS del mes ────────────────────────────────────────────────────
  //
  // `finance.rows` sin recalcular nada: son exactamente las mismas filas que
  // producen el total del mes. Cada una es un hecho — hubo clic en "Ingresar a
  // clase", o quedó una constancia (falta sin aviso, cancelación) que el profesor
  // registró a mano.
  //
  // La partición es por CELDA AGENDADA, no por ingreso: una falta sin aviso no
  // tiene clic pero sí tiene celda, y clasificarla por el clic la dejaba fuera de
  // las dos ramas. Así se perdían 5 clases pagables de Sol y 2 de Florencia, y el
  // embudo "sumaba" solo porque el total se definía como la suma de sus partes.
  const periodos = periodIndex(opts.assignments, opts.dropouts, teacherId);
  const agendadas = new Set<string>();
  for (const a of opts.assignments) {
    if (a.teacherId !== teacherId) continue;
    const dias = new Set((a.slots ?? []).map(s => s.day));
    if (dias.size === 0) continue;
    for (let d = 1; d <= ultimo; d++) {
      const iso = `${monthYear}-${String(d).padStart(2, '0')}`;
      const dayName = DIAS[new Date(iso + 'T00:00:00').getDay()];
      if (!dias.has(dayName)) continue;
      if (!existsForStudent(periodos, a.studentName, iso)) continue;
      agendadas.add(`${nk(a.studentName)}|${iso}`);
    }
  }
  const esAgendada = (r: { studentName: string; date: string }) =>
    agendadas.has(`${nk(r.studentName)}|${r.date}`);

  const hechosMes  = finance.rows.filter(r => inMonth(r.date, monthYear));
  const conRegistro = hechosMes.filter(esAgendada);
  const fuera       = hechosMes.filter(r => !esAgendada(r));

  type Fila = typeof hechosMes[number];
  const unidadesFin = (rs: Fila[]) => rs.reduce((s, r) => s + (r.billingUnits || 1), 0);
  const importe     = (rs: Fila[]) => rs.reduce((s, r) => s + r.rate * (r.billingUnits || 1), 0);
  // Pendiente = todo lo que entró y todavía no se cobra: falta el transcript, o
  // está retenido por un límite. Se agrupa porque para el profesor es lo mismo
  // —dio la clase y no la cobró— y separarlo convertiría el embudo en una tabla.
  const pagablesDe   = (rs: Fila[]) => rs.filter(r => r.status === 'pagable');
  const pendientesDe = (rs: Fila[]) => rs.filter(r => r.status !== 'pagable');
  /** Por qué está pendiente. Solo cuenta lo ya clasificado; no decide nada. */
  const splitDe = (rs: Fila[]) => ({
    transcript: unidadesFin(rs.filter(r => r.status === 'a_revisar')),
    limite:     unidadesFin(rs.filter(r => r.status === 'excede_limite' || r.status === 'excede_limite_tipo')),
  });

  const branches: FunnelBranch[] = [
    {
      key: 'con_ingreso',
      label: 'Con registro de clase',
      count: unidadesFin(conRegistro),
      rows: conRegistro,
      hint: 'Pulsaste «Ingresar a clase», o quedó constancia (falta sin aviso, cancelación).',
      children: [
        {
          key: 'pagables', label: 'Pagables',
          count: unidadesFin(pagablesDe(conRegistro)), amount: importe(pagablesDe(conRegistro)),
          rows: pagablesDe(conRegistro),
          hint: 'Verificadas. Suman a tu total del mes.',
        },
        {
          key: 'pendientes', label: 'Pendientes de cobro',
          count: unidadesFin(pendientesDe(conRegistro)), amount: importe(pendientesDe(conRegistro)),
          rows: pendientesDe(conRegistro),
          pendingSplit: splitDe(pendientesDe(conRegistro)),
          hint: 'Ya las diste y todavía no suman al total: falta el transcript, o están retenidas por el límite del plan.',
        },
      ],
    },
    {
      key: 'sin_ingreso',
      label: 'Sin ingreso registrado',
      count: unidades(missing),
      hint: 'El calendario dice que tocaban y no quedó registro de acceso.',
      children: [
        {
          key: 'reclamables', label: 'Reclamables',
          count: unidades(reclamables),
          hint: 'Tienen transcript o registro: se piden desde Revisiones.',
        },
        {
          key: 'sin_rastro', label: 'Sin transcript ni registro',
          count: unidades(sinRastro),
          hint: 'No quedó ninguna prueba de que ocurrieran.',
        },
      ],
    },
    {
      key: 'fuera_calendario',
      label: 'Fuera del calendario',
      count: unidadesFin(fuera),
      rows: fuera,
      hint: 'Recuperaciones, clases añadidas a mano y horarios cambiados: existen y se cobran, pero no salen de una celda.',
      // Se desglosa igual que "con ingreso" para que `Pagables` del embudo sumado
      // dé EXACTAMENTE el `totalPagable` de finanzas. Sin este desglose, un
      // profesor con recuperaciones veía "Pagables 70" en el embudo y 75 en su
      // total del mes: los dos números que este rediseño viene a eliminar.
      children: [
        {
          key: 'fuera_pagables', label: 'Pagables',
          count: unidadesFin(pagablesDe(fuera)), amount: importe(pagablesDe(fuera)),
          rows: pagablesDe(fuera),
        },
        {
          key: 'fuera_pendientes', label: 'Pendientes de cobro',
          count: unidadesFin(pendientesDe(fuera)), amount: importe(pendientesDe(fuera)),
          rows: pendientesDe(fuera),
          pendingSplit: splitDe(pendientesDe(fuera)),
        },
      ],
    },
  ];

  return {
    monthYear,
    total: branches.reduce((s, b) => s + b.count, 0),
    branches,
    missing,
  };
}

/**
 * Pagables del embudo, sumando las agendadas y las de fuera del calendario.
 *
 * Tiene que dar EXACTAMENTE `finance.totalPagable`. Es la comprobación que
 * impide que el embudo y el total del mes se separen sin que nadie lo note.
 */
export function funnelPayableTotal(f: ClassFunnel): number {
  let n = 0;
  for (const b of f.branches) {
    for (const c of b.children ?? []) {
      if (c.key === 'pagables' || c.key === 'fuera_pagables') n += c.count;
    }
  }
  return n;
}

const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
