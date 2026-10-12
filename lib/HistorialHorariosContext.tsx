'use client';
// ── Historial de horarios (calendar_changes), APARTE de TeachersContext ──────
//
// Con él, las vistas que proyectan fechas PASADAS saben qué horario tenía cada
// alumno ese día (lib/slotHistory). Vivía dentro de TeachersContext y su llegada
// cambiaba la identidad de `teachers` (y de `teacher` en cada pantalla): todo
// efecto con [teacher] se relanzaba. Junto con las funciones sin memoizar, eso
// alimentó el incidente del 08/10/2026.
//
// Ahora:
//   · No se pide nada al entrar en la app: solo cuando se monta una pantalla que
//     lo usa (useHistorialHorarios). Hoy: /asistencias, Registro de clases y
//     Transcripts del admin, finanzas, el embudo de Mis clases, "fuera de
//     calendario", /revisiones y las solicitudes de revisión del admin.
//   · Es un EXTRA y NUNCA se espera: tiempo máximo de 8 s, como mucho una vez
//     cada 10 minutos para toda la app, y si falla cada vista proyecta el horario
//     de hoy, como antes (lib/slotHistory: crearRefrescoHistorial).
//   · Las pantallas lo APLICAN al calcular (profesoresConHistorial,
//     asignacionesConHistorial): su llegada no vuelve a pedir nada.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SlotChange } from '@/types';
import { dbGetSlotChanges } from '@/lib/db';
import { crearRefrescoHistorial, profesoresConHistorial } from '@/lib/slotHistory';

type CambiosPorProfesor = Readonly<Record<string, SlotChange[]>>;

interface HistorialHorariosValue {
  cambios: CambiosPorProfesor;
  /** Pide el historial sin esperarlo (con su tope de frecuencia). Identidad fija. */
  pedir: () => void;
}

const SIN_CAMBIOS: CambiosPorProfesor = Object.freeze({});

const HistorialHorariosContext = createContext<HistorialHorariosValue>({
  cambios: SIN_CAMBIOS,
  pedir: () => {},
});

export function HistorialHorariosProvider({ children }: { children: ReactNode }) {
  const [cambios, setCambios] = useState<CambiosPorProfesor>(SIN_CAMBIOS);
  // Una sola instancia por proveedor (recuerda cuándo se pidió por última vez).
  const [pedir] = useState(() => crearRefrescoHistorial({
    leer: (since, signal) => dbGetSlotChanges(since, signal),
    guardar: setCambios,
  }));
  const value = useMemo(() => ({ cambios, pedir }), [cambios, pedir]);
  return <HistorialHorariosContext.Provider value={value}>{children}</HistorialHorariosContext.Provider>;
}

/** Para las pantallas que proyectan fechas pasadas: lo pide al montarse y lo devuelve. */
export function useHistorialHorarios(): CambiosPorProfesor {
  const { cambios, pedir } = useContext(HistorialHorariosContext);
  useEffect(() => { pedir(); }, [pedir]);
  return cambios;
}

/** Los profesores con su historial; el mismo array mientras no haya historial. */
export function useProfesoresConHistorial<T extends { id: string; slotChanges?: SlotChange[] }>(teachers: T[]): T[] {
  const cambios = useHistorialHorarios();
  return useMemo(() => profesoresConHistorial(teachers, cambios), [teachers, cambios]);
}
