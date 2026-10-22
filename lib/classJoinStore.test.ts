import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logClassJoinWith, requestOriginOf, USER_AGENT_MAX } from './classJoinStore';

describe('requestOriginOf', () => {
  it('prefiere cf-connecting-ip, luego el primer x-forwarded-for, luego x-real-ip', () => {
    expect(requestOriginOf(new Headers({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2', 'x-real-ip': '3.3.3.3' })).ip).toBe('1.1.1.1');
    expect(requestOriginOf(new Headers({ 'x-forwarded-for': ' 2.2.2.2 , 10.0.0.1', 'x-real-ip': '3.3.3.3' })).ip).toBe('2.2.2.2');
    expect(requestOriginOf(new Headers({ 'x-real-ip': '3.3.3.3' })).ip).toBe('3.3.3.3');
    expect(requestOriginOf(new Headers()).ip).toBeNull();
  });

  it('recorta el user agent a 500 caracteres y deja null si no viene', () => {
    expect(requestOriginOf(new Headers({ 'user-agent': 'x'.repeat(900) })).userAgent).toHaveLength(USER_AGENT_MAX);
    expect(requestOriginOf(new Headers()).userAgent).toBeNull();
  });
});

/** Base falsa: guarda lo insertado y puede rechazar las columnas nuevas. */
function fakeDb(opts: { existing?: Record<string, unknown>[]; sinColumnas?: boolean } = {}) {
  const inserts: Record<string, unknown>[] = [];
  const db = {
    from: () => ({
      select: () => ({ eq: () => ({ eq: async () => ({ data: opts.existing ?? [], error: null }) }) }),
      insert: async (row: Record<string, unknown>) => {
        if (opts.sinColumnas && 'ip' in row) return { error: { code: 'PGRST204', message: "Could not find the 'ip' column" } };
        inserts.push(row);
        return { error: null };
      },
    }),
  } as unknown as SupabaseClient;
  return { db, inserts };
}

const input = {
  teacherId: 't1', teacherName: 'Prueba', studentName: 'Alumno', scheduledDate: '2026-10-22', scheduledTime: '17:00',
  subscriptionStatus: 'active', enteredWithoutActive: false, subscriptionDaysRemaining: null, durationHours: 1,
};
const origin = { ip: '1.2.3.4', userAgent: 'Mozilla/5.0' };

describe('logClassJoinWith', () => {
  it('inserta las columnas de siempre más ip y user_agent', async () => {
    const { db, inserts } = fakeDb();
    const log = await logClassJoinWith(db, input, origin);
    expect(Object.keys(inserts[0]).sort()).toEqual([
      'clicked_at', 'entered_without_active', 'id', 'ip', 'punctuality', 'scheduled_date', 'scheduled_time',
      'student_name', 'subscription_days_remaining', 'subscription_status', 'teacher_id', 'teacher_name', 'user_agent',
    ]);
    expect(inserts[0]).toMatchObject({ ip: '1.2.3.4', user_agent: 'Mozilla/5.0', teacher_id: 't1', subscription_days_remaining: null });
    expect(log.id).toBe(inserts[0].id);
  });

  it('sin la migración, guarda el ingreso sin ip/user_agent', async () => {
    const { db, inserts } = fakeDb({ sinColumnas: true });
    await logClassJoinWith(db, input, origin);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).not.toHaveProperty('ip');
  });

  it('segundo clic sobre la misma clase: devuelve el existente y no inserta', async () => {
    const { db, inserts } = fakeDb({ existing: [{ id: 'cjl_x', teacher_id: 't1', student_name: 'alumno ', scheduled_date: '2026-10-22', scheduled_time: '17:00', punctuality: 'late' }] });
    const log = await logClassJoinWith(db, input, origin);
    expect(log.id).toBe('cjl_x');
    expect(inserts).toHaveLength(0);
  });
});
