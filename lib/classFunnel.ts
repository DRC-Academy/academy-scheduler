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
//           ├── Recuperaciones            → reponen una clase perdida
//           ├── Faltas y cancelaciones    → sin celda ese día
//           └── Dadas fuera de tu horario → el resto: la grilla no lo refleja
//
// "Fuera del calendario" no es un cajón de sastre, y por eso se divide por
// ORIGEN y no por estado de pago (ver lib/outOfCalendar): al verla, lo que se
// pregunta el profesor es qué son esas clases, no si están cobradas. Sin esa
// rama el total mentiría: existen, se cobran, y no salen de ninguna celda.
//
// TODO se mide en CLASES (unidades), no en filas: una sesión de 2 horas cuenta 2
// en todas las ramas, igual que en el pago. Así "Pagables" del embudo y
// `totalPagable` de finanzas son el mismo número y no hay que explicar por qué
// difieren.

import type { Assignment, ClassJoinLog, ClassRecord, ClassReviewRequest } from '@/types';
import type { ClassTranscriptRef, TeacherFinanceResult, ClassFinanceRow } from '@/lib/finance';
import type { GridOccupancy } from '@/lib/teacherClasses';
import { buildMissingJoinClasses, type MissingJoinClass } from '@/lib/reviewRequests';
import { type StudentDropout } from '@/lib/studentPeriod';
import { scheduledIndex, originOf, OUT_ORIGINS } from '@/lib/outOfCalendar';


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
   * Reparto de la línea por estado de pago: `pagables + pendientes === count`.
   *
   * Existe por dos motivos. Uno, `funnelPayableTotal` suma ESTO en vez de buscar
   * ramas por su nombre de clave, así que la comprobación sigue valiendo aunque
   * las ramas se reorganicen (que es justo lo que pasó al dividir "fuera del
   * calendario" por origen). Dos, las ramas que no se dividen por estado pueden
   * decir en pantalla cuántas de sus clases ya cuentan y cuántas no.
   *
   * En las ramas que SÍ se dividen por estado ("Pagables" / "Pendientes de
   * cobro") queda con un lado en cero, y la pantalla no lo pinta: repetir
   * "70 pagables" debajo de una línea que se llama "Pagables" es ruido.
   */
  payStatus?: { pagables: number; pendientes: number };
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
  const sched = scheduledIndex({
    assignments: opts.assignments, dropouts: opts.dropouts, teacherId, monthYear,
  });
  const esAgendada = (r: { studentName: string; date: string }) => sched.has(r.studentName, r.date);

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
  /** Reparto por estado de pago. De acá sale `funnelPayableTotal`. */
  const estado = (rs: Fila[]) => ({
    pagables:   unidadesFin(pagablesDe(rs)),
    pendientes: unidadesFin(pendientesDe(rs)),
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
          payStatus: estado(pagablesDe(conRegistro)),
          hint: 'Verificadas. Suman a tu total del mes.',
        },
        {
          key: 'pendientes', label: 'Pendientes de cobro',
          count: unidadesFin(pendientesDe(conRegistro)), amount: importe(pendientesDe(conRegistro)),
          rows: pendientesDe(conRegistro),
          payStatus: estado(pendientesDe(conRegistro)),
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
      payStatus: estado(fuera),
      hint: 'Recuperaciones, faltas y clases dadas otro día: existen y se cobran, pero no salen de una celda.',
      // Se desglosa por ORIGEN, no por estado de pago.
      //
      // Antes eran "Pagables" y "Pendientes de cobro", igual que la rama de
      // arriba. Cuadraba, pero no respondía la única pregunta que se hace el
      // profesor al ver esta rama: qué son esas clases. El estado de pago pasa a
      // ser un dato de cada línea (`payStatus`), que es su sitio.
      //
      // Las tres líneas salen de `originOf` (lib/outOfCalendar) y "dadas fuera de
      // tu horario" es el resto por definición, así que la suma cuadra por
      // construcción. Las que quedan en cero no se pintan.
      children: OUT_ORIGINS.map(o => {
        const rs = fuera.filter(r => originOf(r) === o.key);
        return {
          key: o.branchKey,
          label: o.label,
          hint: o.hint,
          count: unidadesFin(rs),
          amount: importe(rs),
          rows: rs,
          payStatus: estado(rs),
          pendingSplit: splitDe(pendientesDe(rs)),
        };
      }),
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
 *
 * Suma `payStatus.pagables` de cada hoja en vez de buscar las claves 'pagables'
 * y 'fuera_pagables', como hacía antes. Con el desglose por origen esas claves
 * ya no existen, y una comprobación que depende del nombre de una rama deja de
 * comprobar en silencio en cuanto alguien la renombra — que es exactamente el
 * fallo que esta función existe para evitar.
 */
export function funnelPayableTotal(f: ClassFunnel): number {
  let n = 0;
  for (const b of f.branches) {
    for (const c of b.children ?? []) n += c.payStatus?.pagables ?? 0;
  }
  return n;
}

