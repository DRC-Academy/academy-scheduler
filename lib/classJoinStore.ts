// Ingreso a clase (class_join_logs) con el cliente de Supabase INYECTADO.
//
// Es el código de dbLogClassJoin que vivía en lib/db.ts, movido aquí para que lo
// ejecute el SERVIDOR (app/api/class-join) con la service role, y no el navegador
// con la anon key. La fila es la misma de siempre, columna a columna; lo único
// nuevo son `ip` y `user_agent`, que solo el servidor puede ver. NO importa
// lib/supabase.ts.
//
// La nómina (lib/finance.ts) depende de esta tabla: cualquier cambio en lo que
// se escribe aquí cambia lo que se paga.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ClassJoinLog } from '@/types';
import { minutesLateSpain } from './spainTime';

type Db = SupabaseClient;

/**
 * Puntualidad tal como sale de la base, traducida a los tres valores que entiende
 * la aplicación.
 *
 * En `class_join_logs` hay filas antiguas con el valor en español ('a_tiempo'),
 * que ningún código actual escribe. Nadie las traducía, así que llegaban intactas
 * a las pantallas: el panel de admin busca el estilo por ese valor y, al no
 * encontrarlo, la pestaña "Registro de clases" entera dejaba de cargar por tres
 * filas de hace un mes.
 *
 * Un valor desconocido se toma como 'on_time' por el mismo criterio que
 * calcPunctuality cuando la fecha no es válida: ante la duda, no se penaliza.
 */
export function normalizePunctuality(v: unknown): ClassJoinLog['punctuality'] {
  switch (String(v ?? '').trim().toLowerCase()) {
    case 'late':
    case 'tarde':      return 'late';
    case 'very_late':
    case 'muy_tarde':  return 'very_late';
    default:           return 'on_time';
  }
}

function calcPunctuality(scheduledDate: string, scheduledTime: string, clickedAt: Date): ClassJoinLog['punctuality'] {
  // scheduledTime es "HH:00" en hora de ESPAÑA. Antes se construía la hora
  // programada con `new Date(y, m, d, h)`, que usa la zona del navegador: un
  // profesor en Argentina la medía contra las 15:00 argentinas en vez de las
  // españolas, así que entrar 5 h tarde quedaba registrado como 'on_time'.
  const diffMin = minutesLateSpain(scheduledDate, scheduledTime, clickedAt);
  if (isNaN(diffMin)) return 'on_time';   // fecha inválida: no penalizamos
  if (diffMin <= 5)  return 'on_time';
  if (diffMin <= 15) return 'late';
  return 'very_late';
}

/**
 * Ingreso YA registrado para esa misma clase, si lo hay. GUARDA DE DOBLE CLIC:
 * mismo profesor + mismo alumno + misma fecha, con la hora dentro del tramo de
 * la sesión (`durationHours` a partir de `scheduledTime`; una sesión de 2 h
 * cubre sus dos horas). Sin esto cada clic creaba un class_join_log nuevo y la
 * ficha del alumno mostraba una "clase pendiente de transcript" por clic: la
 * auditoría de agosto de 2026 contó 148 clics repetidos.
 *
 * Ante un error de lectura devuelve null (se inserta como siempre): perder un
 * ingreso es peor que duplicarlo.
 */
async function findExistingJoinLog(
  db: Db, teacherId: string, studentName: string, scheduledDate: string, scheduledTime: string, durationHours: number,
): Promise<ClassJoinLog | null> {
  const { data, error } = await db
    .from('class_join_logs')
    .select('*')
    .eq('teacher_id', teacherId)
    .eq('scheduled_date', scheduledDate);
  if (error || !data) return null;

  const name = studentName.trim().toLowerCase();
  const start = parseInt(scheduledTime, 10);
  const span = Math.max(1, durationHours || 1);
  const dup = data.find(row => {
    if ((row.student_name ?? '').trim().toLowerCase() !== name) return false;
    const h = parseInt(row.scheduled_time ?? '', 10);
    if (!Number.isFinite(start) || !Number.isFinite(h)) return row.scheduled_time === scheduledTime;
    // Misma hora, u otra hora del mismo bloque (17:00 y 18:00 de una sesión de 2 h).
    return Math.abs(h - start) < span;
  });
  if (!dup) return null;

  return {
    id: dup.id, teacherId: dup.teacher_id, teacherName: dup.teacher_name, studentName: dup.student_name,
    scheduledDate: dup.scheduled_date, scheduledTime: dup.scheduled_time, clickedAt: dup.clicked_at,
    punctuality: normalizePunctuality(dup.punctuality),
    subscriptionStatus: dup.subscription_status ?? undefined,
    enteredWithoutActive: dup.entered_without_active ?? false,
    subscriptionDaysRemaining: dup.subscription_days_remaining ?? undefined,
    source: dup.source === 'manual' ? 'manual' : 'click',
    transcriptDeadlineAt: dup.transcript_deadline_at ?? undefined,
  };
}

/** Lo que manda el navegador al pulsar "Ingresar a clase" (los argumentos de siempre). */
export interface ClassJoinInput {
  teacherId: string;
  teacherName: string;
  studentName: string;
  scheduledDate: string;
  scheduledTime: string;
  subscriptionStatus?: string;
  enteredWithoutActive?: boolean;
  subscriptionDaysRemaining?: number | null;
  /** Horas de la sesión que se está abriendo (2 en un bloque de dos celdas). Solo para la guarda de doble clic. */
  durationHours?: number;
}

/** Desde dónde se pulsó. Lo pone el servidor a partir de las cabeceras, nunca el navegador. */
export interface ClassJoinOrigin {
  ip: string | null;
  userAgent: string | null;
}

/** Tope de `user_agent`: alcanza para cualquier navegador real y acota la fila. */
export const USER_AGENT_MAX = 500;

/**
 * IP y navegador de la petición. La IP, por orden: cf-connecting-ip, el PRIMER
 * valor de x-forwarded-for (el cliente; los siguientes son proxies) y x-real-ip.
 */
export function requestOriginOf(headers: Headers): ClassJoinOrigin {
  const first = (v: string | null) => v?.split(',')[0]?.trim() || null;
  const ip = first(headers.get('cf-connecting-ip'))
    ?? first(headers.get('x-forwarded-for'))
    ?? first(headers.get('x-real-ip'));
  const ua = headers.get('user-agent')?.trim() || null;
  return { ip, userAgent: ua ? ua.slice(0, USER_AGENT_MAX) : null };
}

/**
 * Registra el ingreso. Segundo clic sobre la misma clase → devuelve el ingreso
 * que ya existe y no inserta nada. LANZA si no se pudo guardar.
 *
 * Si las columnas `ip`/`user_agent` todavía no existen (SQL sin correr), reintenta
 * sin ellas: el ingreso decide el pago y no puede caerse por una migración de
 * auditoría. Ver supabase-join-log-origin.sql.
 */
export async function logClassJoinWith(db: Db, input: ClassJoinInput, origin: ClassJoinOrigin): Promise<ClassJoinLog> {
  const {
    teacherId, teacherName, studentName, scheduledDate, scheduledTime,
    subscriptionStatus, enteredWithoutActive, subscriptionDaysRemaining, durationHours = 1,
  } = input;

  const existing = await findExistingJoinLog(db, teacherId, studentName, scheduledDate, scheduledTime, durationHours);
  if (existing) return existing;

  const clickedAt   = new Date();
  const punctuality = calcPunctuality(scheduledDate, scheduledTime, clickedAt);
  const id          = `cjl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const row = {
    id,
    teacher_id:                  teacherId,
    teacher_name:                teacherName,
    student_name:                studentName,
    scheduled_date:              scheduledDate,
    scheduled_time:              scheduledTime,
    clicked_at:                  clickedAt.toISOString(),
    punctuality,
    subscription_status:         subscriptionStatus ?? null,
    entered_without_active:      enteredWithoutActive ?? false,
    subscription_days_remaining: subscriptionDaysRemaining ?? null,
  };

  let { error } = await db.from('class_join_logs').insert({ ...row, ip: origin.ip, user_agent: origin.userAgent });
  if (error && (error.code === 'PGRST204' || error.code === '42703')) {
    console.warn('[class_join_logs] Sin columnas ip/user_agent: el ingreso se guarda sin ellas. Correr supabase-join-log-origin.sql.');
    ({ error } = await db.from('class_join_logs').insert(row));
  }
  if (error) {
    console.error('[class_join_logs] No se pudo registrar el ingreso:', error);
    throw new Error(`No se pudo registrar el ingreso: ${error.message}`);
  }

  return {
    id, teacherId, teacherName, studentName,
    scheduledDate, scheduledTime,
    clickedAt: clickedAt.toISOString(),
    punctuality,
    subscriptionStatus,
    enteredWithoutActive: enteredWithoutActive ?? false,
    subscriptionDaysRemaining: subscriptionDaysRemaining ?? undefined,
  };
}
