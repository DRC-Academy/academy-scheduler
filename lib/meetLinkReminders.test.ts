import { describe, expect, it } from 'vitest';
import { planMeetLinkReminders, type ReminderRow } from './meetLinkReminders';

const H = 3_600_000;
const now = Date.parse('2026-10-10T12:00:00Z');

function row(hoursAgo: number, flags: Partial<Pick<ReminderRow, 'presentation_reminder_4h_sent' | 'presentation_reminder_12h_sent' | 'presentation_reminder_24h_sent'>> = {}, teacher = 't1'): ReminderRow {
  return {
    id: 'a1', teacher_id: teacher, teacher_name: 'Ana', student_name: 'Pepe',
    created_at: new Date(now - hoursAgo * H).toISOString(),
    presentation_reminder_4h_sent: false, presentation_reminder_12h_sent: false, presentation_reminder_24h_sent: false,
    ...flags,
  };
}

describe('planMeetLinkReminders', () => {
  it('antes de 4 h no hay nada', () => {
    expect(planMeetLinkReminders([row(3)], now)).toEqual([]);
  });

  it('a las 4 h: solo al profe, con ids que llevan asignación y profesor', () => {
    const [p] = planMeetLinkReminders([row(5)], now);
    expect(p.threshold).toBe('4h');
    expect(p.emails).toEqual([{ claimId: 'drl_meetlink_4h_teacher_a1_t1', to: 'teacher' }]);
    expect(p.notifications.map(n => n.id)).toEqual(['meetlink_4h_teacher_a1_t1']);
    expect(p.notifications[0].type).toBe('presentation_email_reminder');
    expect(p.flags).toEqual(['presentation_reminder_4h_sent']);
  });

  it('a las 12 h con el 4 h ya cubierto: profe y admin', () => {
    const [p] = planMeetLinkReminders([row(13, { presentation_reminder_4h_sent: true })], now);
    expect(p.threshold).toBe('12h');
    expect(p.emails.map(e => e.to)).toEqual(['teacher', 'admin']);
    expect(p.notifications[1].body).toBe('Ana aún no ha definido el enlace de Pepe (13 h).');
  });

  it('atrasos: si vencen varios a la vez se manda solo el más alto y se cubren todos', () => {
    const [p] = planMeetLinkReminders([row(30)], now);
    expect(p.threshold).toBe('24h');
    expect(p.flags).toEqual(['presentation_reminder_4h_sent', 'presentation_reminder_12h_sent', 'presentation_reminder_24h_sent']);
    expect(p.notifications.every(n => n.id.startsWith('meetlink_24h_'))).toBe(true);
  });

  it('todo cubierto → nada; más de 96 h → nada', () => {
    expect(planMeetLinkReminders([row(30, { presentation_reminder_4h_sent: true, presentation_reminder_12h_sent: true, presentation_reminder_24h_sent: true })], now)).toEqual([]);
    expect(planMeetLinkReminders([row(97)], now)).toEqual([]);
  });

  it('tras un cambio de profesor los ids cambian: el nuevo recibe sus avisos', () => {
    const [p] = planMeetLinkReminders([row(5, {}, 't2')], now);
    expect(p.emails[0].claimId).toBe('drl_meetlink_4h_teacher_a1_t2');
  });
});
