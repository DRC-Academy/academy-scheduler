'use client';
import { useState } from 'react';
import { Assignment, AssignedSlot } from '@/types';

// Modal del email de asignación al profesor. Fuente ÚNICA del cuerpo del correo de
// "nueva asignación" que se pre-arma para abrir en el gestor de correo (mailto).
// Se usa tanto al asignar por primera vez (Setter) como al cambiar de profesor
// (CambiarProfesorModal), garantizando que el texto sea idéntico en ambos casos.

const DAY_INDEX: Record<string, number> = {
  Lunes: 0, Martes: 1, Miércoles: 2, Jueves: 3, Viernes: 4, Sábado: 5,
};

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// "2026-07-02" → "Miércoles 2 de julio de 2026" (día de semana capitalizado, sin coma).
function fmtLongDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  if (isNaN(d.getTime())) return '';
  const s = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const noComma = s.replace(',', '');
  return noComma.charAt(0).toUpperCase() + noComma.slice(1);
}

// Un slot → "• Lunes 16:00h - 17:00h" (hora fin = inicio + 1h). Tolera "16" o "16:00".
function slotLine(s: AssignedSlot): string {
  const startH = parseInt(s.hour, 10);
  const start = `${String(startH).padStart(2, '0')}:00`;
  const end = `${String(startH + 1).padStart(2, '0')}:00`;
  return `• ${s.day} ${start}h - ${end}h`;
}

// Limpia el nombre del plan: corta metadatos de horario (todo tras " · ") y colapsa
// duplicados tipo "3h semanales · 3h semanales" → "3h semanales".
function cleanPlanName(raw: string): string {
  if (!raw) return '';
  let s = raw.split('·')[0].trim();          // descarta "· 16:00 · Lunes, miércoles..."
  s = s.replace(/\s*[—–]\s*/g, ' - ');       // separadores de Woo a un formato único, para poder partir
  const parts = s.split(/\s+-\s+/).map(p => p.trim()).filter(Boolean);
  const dedup: string[] = [];
  for (const p of parts) {
    if (!dedup.some(d => d.toLowerCase() === p.toLowerCase())) dedup.push(p);
  }
  // Se une con punto medio: en DRC no se usan guiones como separadores.
  return dedup.join(' · ');
}

// Construye asunto + cuerpo + destinatario del email de asignación a partir de la
// assignment. Función pura reutilizable (tests / previews).
export function buildAssignmentEmail(assignment: Assignment): { subject: string; body: string; to: string } {
  const now = new Date();
  const greeting = now.getHours() < 13 ? 'Buenos días' : now.getHours() < 20 ? 'Buenas tardes' : 'Buenas noches';

  const startDateLong = fmtLongDate(assignment.startDate ?? '');
  const renewalStr = assignment.startDate ? fmtDate(addDays(assignment.startDate, 30)) : null;

  const orderedSlots = [...assignment.slots].sort((a, b) => {
    const d = (DAY_INDEX[a.day] ?? 99) - (DAY_INDEX[b.day] ?? 99);
    return d !== 0 ? d : parseInt(a.hour, 10) - parseInt(b.hour, 10);
  });
  const scheduleBlock = orderedSlots.map(slotLine).join('\n');

  const planName = cleanPlanName(assignment.plan);
  const objetivo = assignment.objetivo?.trim() || 'Mejorar su nivel de inglés';

  const subject = `Nueva asignación: ${assignment.studentName} - ${planName}`;
  const body = `${greeting} ${assignment.teacherName.split(' ')[0]}!

A continuación te envío la información de ${assignment.studentName} para comenzar sus clases.

Recuerda enviarle el correo de presentación y el correo con los datos de la sesión.

📅 Fecha de inicio: ${startDateLong}

🕐 Horario semanal (Hora España):
${scheduleBlock}

📧 Email de contacto: ${assignment.studentEmail}
🎯 Objetivo: ${objetivo}
📊 Nivel: ${assignment.studentLevel}
📦 Plan: ${planName}

${assignment.studentName} ha comprado su plan ${planName}${renewalStr ? ` y renueva el ${renewalStr}` : ''}.

Recuerda pedir que te confirmen que han recibido el email.`;

  return { subject, body, to: assignment.teacherEmail };
}

export function AssignmentEmailModal({
  assignment, onClose, banner, title = '📧 Enviar email al profesor', skipLabel,
}: {
  assignment: Assignment;
  onClose: () => void;
  banner?: string;      // mensaje de éxito opcional (ej. tras cambiar de profesor)
  title?: string;
  skipLabel?: string;   // si se pasa, muestra un botón secundario "omitir" que cierra
}) {
  const [sent, setSent] = useState(false);
  const { subject: emailSubject, body: emailBody, to } = buildAssignmentEmail(assignment);
  const mailtoLink = `mailto:${to}?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(emailBody)}`;

  function copyBody() { navigator.clipboard.writeText(emailBody).catch(() => {}); }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 18, width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', padding: 28 }}>
        {banner && (
          <div style={{ marginBottom: 16, padding: '11px 15px', background: 'rgba(30,158,58,0.09)', border: '1px solid rgba(30,158,58,0.28)', borderRadius: 10, fontSize: 13, color: '#167a2d', lineHeight: 1.5 }}>
            {banner}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}>{title}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>Para: {to}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 22, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Asunto</div>
          <div style={{ background: 'var(--bg-surface-2)', borderRadius: 8, padding: '9px 13px', fontSize: 13, color: 'var(--text-primary)', border: '1px solid var(--border)', fontWeight: 600 }}>{emailSubject}</div>
        </div>
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Cuerpo del email</div>
          <div style={{ background: 'var(--bg-surface-2)', borderRadius: 10, padding: '14px 16px', fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', lineHeight: 1.7, border: '1px solid var(--border)', maxHeight: 340, overflowY: 'auto' }}>{emailBody}</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={copyBody} style={{ flex: 1, padding: '11px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg-surface-3)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>📋 Copiar cuerpo</button>
          <a href={mailtoLink} onClick={() => setSent(true)}
            style={{ flex: 2, padding: '11px', borderRadius: 9, border: 'none', background: '#1E9E3A', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 700, textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}>
            {sent ? '✓ Email abierto' : '📧 Abrir en gestor de correo'}
          </a>
        </div>
        {skipLabel && (
          <button onClick={onClose} style={{ width: '100%', marginTop: 10, padding: '10px', borderRadius: 9, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            {skipLabel}
          </button>
        )}
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
          Se abre tu cliente de correo con el email prellenado
        </div>
      </div>
    </div>
  );
}
