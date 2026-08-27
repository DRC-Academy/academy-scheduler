// Datos REALES de agosto 2026 (salida de la verificación contra producción).
// Los cuatro casos del embudo y el informe de calendarios del admin.

export const CASOS = {
  agustin: {
    nombre: 'Agustin', total: 345.50, clases: 345.50, bonos: 0, penal: 0,
    claim: { n: 46, eur: 208.50 }, total_clases: 124,
    ramas: [
      { c: 'con', label: 'Con registro de clase', n: 70,
        hint: 'Pulsaste «Ingresar a clase», o quedó constancia (falta sin aviso, cancelación).',
        hijos: [
          { tipo: 'pag', label: 'Pagables', n: 70, eur: 323.50 },
          { tipo: 'pend', label: 'Pendientes de cobro', n: 0, eur: 0, t: 0, l: 0 },
        ] },
      { c: 'sin', label: 'Sin ingreso registrado', n: 46,
        hint: 'El calendario dice que tocaban y no quedó registro de acceso.',
        hijos: [
          { tipo: 'recl', label: 'Reclamables', n: 46, eur: 208.50 },
          { tipo: 'llano', label: 'Sin transcript ni registro', n: 0 },
        ] },
      { c: 'fuera', label: 'Fuera del calendario', n: 8,
        hint: 'Recuperaciones, faltas y clases dadas otro día: existen y se cobran, pero no salen de una celda.',
        hijos: [
          { tipo: 'origen', label: 'Recuperaciones', n: 0, eur: 0, pag: 0, pend: 0 },
          { tipo: 'origen', label: 'Faltas y cancelaciones', n: 0, eur: 0, pag: 0, pend: 0 },
          { tipo: 'origen', label: 'Dadas fuera de tu horario', n: 8, eur: 35.00, pag: 5, pend: 3 },
        ] },
    ],
    filtros: { todas: 78, pagables: 75, pendientes: 3 },
  },
  silvia: {
    nombre: 'Silvia', total: 374.50, clases: 374.50, bonos: 0, penal: 0,
    claim: { n: 5, eur: 22.50 }, total_clases: 93,
    ramas: [
      { c: 'con', label: 'Con registro de clase', n: 67,
        hint: 'Pulsaste «Ingresar a clase», o quedó constancia (falta sin aviso, cancelación).',
        hijos: [
          { tipo: 'pag', label: 'Pagables', n: 66, eur: 298.00 },
          { tipo: 'pend', label: 'Pendientes de cobro', n: 1, eur: 4.50, t: 1, l: 0 },
        ] },
      { c: 'sin', label: 'Sin ingreso registrado', n: 9,
        hint: 'El calendario dice que tocaban y no quedó registro de acceso.',
        hijos: [
          { tipo: 'recl', label: 'Reclamables', n: 5, eur: 22.50 },
          { tipo: 'llano', label: 'Sin transcript ni registro', n: 4 },
        ] },
      { c: 'fuera', label: 'Fuera del calendario', n: 17,
        hint: 'Recuperaciones, faltas y clases dadas otro día: existen y se cobran, pero no salen de una celda.',
        hijos: [
          { tipo: 'origen', label: 'Recuperaciones', n: 16, eur: 72.50, pag: 16, pend: 0 },
          { tipo: 'origen', label: 'Faltas y cancelaciones', n: 0, eur: 0, pag: 0, pend: 0 },
          { tipo: 'origen', label: 'Dadas fuera de tu horario', n: 1, eur: 4.00, pag: 1, pend: 0 },
        ] },
    ],
    filtros: { todas: 84, pagables: 83, pendientes: 1 },
  },
  solg: {
    nombre: 'Sol.G', total: -1.00, clases: 9.00, bonos: 0, penal: -10.00,
    claim: null, total_clases: 82,
    ramas: [
      { c: 'con', label: 'Con registro de clase', n: 0,
        hint: 'Pulsaste «Ingresar a clase», o quedó constancia (falta sin aviso, cancelación).',
        hijos: [
          { tipo: 'pag', label: 'Pagables', n: 0, eur: 0 },
          { tipo: 'pend', label: 'Pendientes de cobro', n: 0, eur: 0, t: 0, l: 0 },
        ] },
      { c: 'sin', label: 'Sin ingreso registrado', n: 80, nada: true,
        hint: 'El calendario dice que tocaban y no quedó registro de acceso.',
        hijos: [
          { tipo: 'recl', label: 'Reclamables', n: 0 },
          { tipo: 'llano', label: 'Sin transcript ni registro', n: 80 },
        ] },
      { c: 'fuera', label: 'Fuera del calendario', n: 2,
        hint: 'Recuperaciones, faltas y clases dadas otro día: existen y se cobran, pero no salen de una celda.',
        hijos: [
          { tipo: 'origen', label: 'Recuperaciones', n: 0, eur: 0, pag: 0, pend: 0 },
          { tipo: 'origen', label: 'Faltas y cancelaciones', n: 2, eur: 9.00, pag: 2, pend: 0 },
          { tipo: 'origen', label: 'Dadas fuera de tu horario', n: 0, eur: 0, pag: 0, pend: 0 },
        ] },
    ],
    filtros: { todas: 2, pagables: 2, pendientes: 0 },
    penalDetalle: [
      { txt: 'Falta sin aviso — Camila Ruiz, 12 ago', eur: 5 },
      { txt: 'Falta sin aviso — Camila Ruiz, 19 ago', eur: 5 },
    ],
  },
  dana: {
    nombre: 'Dana', total: 305.50, clases: 305.50, bonos: 0, penal: 0,
    claim: { n: 9, eur: 37.00 }, total_clases: 141,
    ramas: [
      { c: 'con', label: 'Con registro de clase', n: 74,
        hint: 'Pulsaste «Ingresar a clase», o quedó constancia (falta sin aviso, cancelación).',
        hijos: [
          { tipo: 'pag', label: 'Pagables', n: 56, eur: 238.00 },
          { tipo: 'pend', label: 'Pendientes de cobro', n: 18, eur: 78.00, t: 18, l: 0 },
        ] },
      { c: 'sin', label: 'Sin ingreso registrado', n: 36,
        hint: 'El calendario dice que tocaban y no quedó registro de acceso.',
        hijos: [
          { tipo: 'recl', label: 'Reclamables', n: 9, eur: 37.00 },
          { tipo: 'llano', label: 'Sin transcript ni registro', n: 27 },
        ] },
      { c: 'fuera', label: 'Fuera del calendario', n: 31,
        hint: 'Recuperaciones, faltas y clases dadas otro día: existen y se cobran, pero no salen de una celda.',
        hijos: [
          { tipo: 'origen', label: 'Recuperaciones', n: 17, eur: 77.00, pag: 12, pend: 5 },
          { tipo: 'origen', label: 'Faltas y cancelaciones', n: 3, eur: 13.50, pag: 2, pend: 1 },
          { tipo: 'origen', label: 'Dadas fuera de tu horario', n: 11, eur: 48.50, pag: 1, pend: 10 },
        ] },
    ],
    filtros: { todas: 105, pagables: 71, pendientes: 34 },
  },
};

/** Las tres ayudas, tal cual salen de lib/outOfCalendar. */
export const AYUDAS = {
  'Recuperaciones': 'Clases que diste para reponer una que se había perdido. Salen de una celda bloqueada del calendario, por eso no aparecen en tu horario habitual. Se cobran, y no consumen cupo del alumno.',
  'Faltas y cancelaciones': 'El alumno no vino o canceló sobre la hora, en un día que no tenía clase agendada. Se cobran sin transcript.',
  'Dadas fuera de tu horario': 'Diste la clase un día que el calendario no tiene marcado para ese alumno. Suele ser un cambio de horario que no se reflejó en la grilla. Se cobra igual.',
};

/** La fila plegada del admin. Sale solo de `finance`, sin consultas extra. */
export const ADMIN = [
  { n: 'Agustin',  pag: 75, rev: 3,  ret: 0, bon: 0, eurPag: 345.50, eurRev: 13.00,  eurRet: 0,    tot: 345.50 },
  { n: 'Silvia',   pag: 83, rev: 1,  ret: 0, bon: 0, eurPag: 374.50, eurRev: 4.50,   eurRet: 0,    tot: 374.50 },
  { n: 'Dana',     pag: 71, rev: 32, ret: 2, bon: 0, eurPag: 305.50, eurRev: 141.00, eurRet: 9.00, tot: 305.50 },
  { n: 'Wanda',    pag: 75, rev: 5,  ret: 0, bon: 0, eurPag: 353.50, eurRev: 22.50,  eurRet: 0,    tot: 353.50 },
  { n: 'DanielaN', pag: 49, rev: 14, ret: 0, bon: 0, eurPag: 211.50, eurRev: 62.00,  eurRet: 0,    tot: 211.50 },
  { n: 'Sol.G',    pag: 2,  rev: 0,  ret: 0, bon: 0, eurPag: 9.00,   eurRev: 0,      eurRet: 0,    tot: -1.00 },
];

/** El informe de calendarios desincronizados. Agosto real.
 *  Solo lo MEDIDO: totales por grupo y las filas plegadas con su recuento. Las
 *  fechas de cada clase salen al desplegar y no se inventan acá. */
export const DRIFT = [
  {
    key: 'sin_celda_activo', label: 'Sin celda y sin baja',
    hint: 'El alumno no tiene ninguna celda en el calendario del profesor y tampoco está dado de baja. El calendario y la ficha están desincronizados: hay que devolverle sus horas o darlo de baja.',
    alumnos: 11, clases: 38, eur: 167.50,
    items: [
      { prof: 'Wanda', alu: 'Ester Domènech Rodríguez', n: 8, eur: 40.00 },
      { prof: 'Dana', alu: 'Sofía Garcés Meléndez', n: 5, eur: 23.50 },
      { prof: 'Johny', alu: 'Cristian Díaz Gonzalez', n: 5, eur: 20.00 },
      { prof: 'Johny', alu: 'Miguel Ángel Mora Reina', n: 5, eur: 20.00 },
      { prof: 'Liliana', alu: 'Barbara cordero sabo', n: 4, eur: 18.00 },
      { prof: 'Agustin', alu: 'Beatriz Benavides', n: 3, eur: 13.50 },
      { prof: 'DanielaN', alu: 'Victoria Lucas Guerrero', n: 3, eur: 12.00 },
      { prof: 'Florencia', alu: 'Alejandro Barrés Gozálvez', n: 2, eur: 8.00 },
      { prof: 'Dana', alu: 'Susana Manrique', n: 1, eur: 4.00 },
      { prof: 'DanielaN', alu: 'Mercedez Morilla', n: 1, eur: 4.50 },
      { prof: 'Florencia', alu: 'Laura Miquel', n: 1, eur: 4.00 },
    ],
  },
  {
    key: 'dia_ajeno', label: 'Día que no es suyo',
    hint: 'El alumno sí tiene celdas, pero la clase se dio otro día. Suele ser un cambio de horario que nadie reflejó en la grilla.',
    alumnos: 20, clases: 30, eur: 135.00,
    items: [
      { prof: 'Daiana.M', alu: 'Alba Coca', n: 3, dias: 'Jueves, Viernes' },
      { prof: 'Ignacio', alu: 'Nayara Cornejo Palacios', n: 2, dias: 'Viernes' },
      { prof: 'Agustin', alu: 'Noemi Viñas Sánchez', n: 1, dias: 'Lunes, Martes, Miércoles' },
      { prof: 'Daiana.M', alu: 'Mónica Prats', n: 1, dias: 'Viernes' },
    ],
    mas: 16,
  },
  {
    key: 'baja', label: 'Dado de baja',
    hint: 'El alumno está dado de baja y aun así hubo clase ese día. Es normal en el mes de la baja: las últimas clases se dan después de registrarla.',
    alumnos: 6, clases: 11, eur: 45.50,
    items: [],
    mas: 6,
  },
];
