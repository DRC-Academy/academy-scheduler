'use client';
// ── Modal "Email de presentación" (email de bienvenida al alumno) ──────────────
// Fuente ÚNICA del modal que arma el email de presentación. Se usa desde el panel
// del profesor (Avisos y Próximas clases) y desde el popup recordatorio montado en
// el NavBar (components/PresentationEmailReminder), para que el texto y el flujo
// sean idénticos en todos los puntos de entrada.
//
// No se ofrece "abrir en gestor de correo": mailto: depende de que el sistema
// operativo tenga un cliente registrado y falla en silencio cuando no lo hay (el
// caso normal con Gmail en el navegador). El flujo es copiar el texto y pegarlo.
import { useState, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { useTeachers } from '@/lib/TeachersContext';
import { classifyPlan } from '@/lib/productUtils';
import { resolveGender, g } from '@/lib/gender';
import { getOrCreateFormLink } from '@/lib/formClient';
import { Teacher, Assignment, Student } from '@/types';

const MEET_PLACEHOLDER = '[PENDIENTE - completar enlace de Meet]';
const DAY_NAMES_BY_JSDAY = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// Descripción amigable del plan para el cuerpo del email.
function planDescription(a: Assignment, student?: Student): string {
  const c = classifyPlan({
    assignmentPlan:     a.plan,
    assignmentObjetivo: a.objetivo,
    studentPlan:        student?.plan,
    productName:        student?.productName,
  });
  if (c.financeType === 'examenes') return 'nuestra preparación para el examen';
  if (c.type === 'intensivo')       return 'nuestro programa intensivo';
  return 'el aprendizaje del inglés';
}

// Primera clase del alumno: la fecha más próxima (a partir de start_date, o de
// hoy si no hay) que cae en alguno de sus slots recurrentes, con hora inicio/fin.
function firstClassInfo(a: Assignment): { dateLabel: string; horaInicio: string; horaFin: string } | null {
  if (!a.slots || a.slots.length === 0) return null;
  const start = a.startDate ? new Date(a.startDate + 'T00:00:00') : new Date();
  if (isNaN(start.getTime())) return null;
  let best: { date: Date; hour: string } | null = null;
  for (const slot of a.slots) {
    const dow = DAY_NAMES_BY_JSDAY.indexOf(slot.day);
    if (dow < 0) continue;
    const d = new Date(start);
    d.setDate(d.getDate() + ((dow - d.getDay() + 7) % 7));
    const better = !best || d.getTime() < best.date.getTime() ||
      (d.getTime() === best.date.getTime() && parseInt(slot.hour) < parseInt(best.hour));
    if (better) best = { date: d, hour: slot.hour };
  }
  if (!best) return null;
  const h = parseInt(best.hour);
  const weekday = best.date.toLocaleDateString('es-ES', { weekday: 'long' });
  const month   = best.date.toLocaleDateString('es-ES', { month: 'long' });
  return {
    dateLabel:  `${weekday} ${best.date.getDate()} de ${month}`,   // "lunes 7 de julio"
    horaInicio: `${String(h).padStart(2, '0')}:00`,
    horaFin:    `${String(h + 1).padStart(2, '0')}:00`,
  };
}

// Cuerpo del email con los campos dinámicos ya reemplazados.
export function buildPresentationBody(a: Assignment, teacher: Teacher, student: Student | undefined, meetLink: string, formUrl?: string): string {
  const info  = firstClassInfo(a);
  const fecha = info ? info.dateLabel : '[fecha de la primera clase]';
  const hIni  = info ? info.horaInicio : '[hora]';
  const hFin  = info ? info.horaFin : '[hora]';
  const link  = meetLink.trim() || MEET_PLACEHOLDER;
  // Género del profe para "elegido/a" y "profesor/a" (dato explícito o detectado por nombre).
  const tg    = resolveGender(teacher.gender, teacher.name);
  // Sección del formulario inicial (ÚNICO link del email). Al terminarlo, el propio
  // formulario ofrece el test de nivel, así que aquí solo lo mencionamos: un solo
  // enlace mantiene el foco del alumno en lo importante.
  const formBlock = formUrl?.trim()
    ? `

Y antes de nuestro primer encuentro, me gustaría conocerte un poco mejor 💚 Te dejo este breve formulario (son solo unos minutos) para preparar una clase 100% tuya desde el primer minuto:

${formUrl.trim()}

Al terminarlo podrás hacer también un pequeño test de nivel: te dirá al instante en qué nivel de inglés te encuentras y nos vendrá muy bien para preparar tu primera clase, así que te recomiendo hacerlo 🙂
`
    : '';
  return `¡Buenos días, ${a.studentName}!

¡Es un placer saludarte! Mi nombre es ${teacher.name} y he sido ${g(tg, 'elegido', 'elegida', 'elegido/a')} como tu ${g(tg, 'profesor', 'profesora', 'profesor/a')} en DRC Academy.

Será un gusto conocerte en nuestra primera clase el ${fecha} de ${hIni} a ${hFin}h.

¡Juntos continuaremos con ${planDescription(a, student)} y nos divertiremos en el proceso!

A través del siguiente enlace podrás acceder a nuestra clase por Meet. (Usaremos el mismo para todas nuestras clases 🙂)

${link}${formBlock}

Si pudieras confirmar que has recibido este email, ¡te lo agradecería mucho!

¡Un saludo!
${teacher.name}`;
}

export function PresentationModal({ assignment, teacher, students, updateMeetLink, onClose, onSent, onFormTokenReady }: {
  assignment: Assignment;
  teacher: Teacher;
  students: Student[];
  updateMeetLink: (assignmentId: string, link: string) => Promise<void>;
  onClose: () => void;
  onSent: (studentName: string) => void;
  onFormTokenReady?: () => void;
}) {
  const { markPresentationSent } = useTeachers();

  // Lookup del alumno (email real + plan/producto) para clasificar y prellenar.
  const student = useMemo(() => {
    const byEmail = assignment.studentEmail?.trim().toLowerCase();
    return (byEmail ? students.find(s => s.email?.trim().toLowerCase() === byEmail) : undefined)
        ?? students.find(s => s.name.trim().toLowerCase() === assignment.studentName.trim().toLowerCase());
  }, [students, assignment]);

  const [meetLink, setMeetLink] = useState(assignment.meetLink ?? '');
  const [toEmail, setToEmail]   = useState(student?.email ?? assignment.studentEmail ?? '');
  const [subject, setSubject]   = useState(`¡Bienvenido/a a DRC Academy, ${assignment.studentName}!`);
  const [formUrl, setFormUrl]   = useState('');   // link del formulario inicial (se resuelve al abrir)
  const [body, setBody]         = useState(() => buildPresentationBody(assignment, teacher, student, assignment.meetLink ?? '', ''));
  const [toast, setToast]       = useState<string | null>(null);
  const [marking, setMarking]   = useState(false);   // PATCH de "marcar enviado" en vuelo
  const lastGenRef = useRef(body);

  // Al abrir, resolvemos el link del formulario inicial (reutiliza token vigente
  // o genera uno) para incluirlo en el mismo correo de presentación.
  useEffect(() => {
    let cancelled = false;
    getOrCreateFormLink({
      studentId: assignment.studentId || undefined,
      studentName: assignment.studentName,
      studentEmail: student?.email ?? assignment.studentEmail ?? undefined,
      teacherId: teacher.id,
      teacherName: teacher.name,
      assignmentId: assignment.id,
      plan: assignment.plan ?? undefined,
      level: assignment.studentLevel ?? undefined,
    }).then(url => {
      if (cancelled) return;
      setFormUrl(url);
      onFormTokenReady?.();
    }).catch(() => {});

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Si el usuario no editó el cuerpo, se regenera al cambiar el enlace de Meet o
  // al resolverse el link del formulario. Se captura el valor previo generado
  // ANTES de mutar el ref, porque el updater de setBody lee el ref al ejecutarse.
  useEffect(() => {
    const prevGen = lastGenRef.current;
    const regenerated = buildPresentationBody(assignment, teacher, student, meetLink, formUrl);
    lastGenRef.current = regenerated;
    setBody(prev => (prev === prevGen ? regenerated : prev));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetLink, student, formUrl]);

  // Guarda el enlace de Meet en la assignment (acción real, independiente del envío).
  async function saveMeetIfAny() {
    if (!meetLink.trim()) return;
    try { await updateMeetLink(assignment.id, meetLink.trim()); setToast('✅ Enlace de Meet guardado'); }
    catch { setToast('⚠️ No se pudo guardar el enlace'); }
  }

  // Copia el email al portapapeles para pegarlo en el webmail. NO marca nada:
  // copiar no es enviar, y no hay forma de saber si el profesor llegó a enviarlo.
  async function handleCopy() {
    const text = `Para: ${toEmail.trim()}\nAsunto: ${subject}\n\n${body}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    }
    await saveMeetIfAny();
    setToast('📋 Email copiado — pégalo en Gmail');
  }

  // ÚNICA vía por la que el email pasa a "enviado": el profesor lo afirma
  // explícitamente. Persiste en la asignación (y aplica -5 al scoring si pasaron
  // más de 24 h desde la asignación) y refleja el estado local del badge.
  // No es best-effort: si el PATCH falla hay que decirlo, porque si no el profesor
  // cree que quedó registrado y el aviso le sigue corriendo.
  async function handleMarkSent() {
    setMarking(true);
    try {
      await markPresentationSent(assignment.id);
      await saveMeetIfAny();
      onSent(assignment.studentName);
      setToast('✅ Presentación marcada como enviada');
      setTimeout(onClose, 900);
    } catch {
      setToast('⚠️ No se pudo marcar como enviada — inténtalo de nuevo');
      setMarking(false);
    }
  }

  const fieldLabel: CSSProperties = { display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 };
  const lightInput: CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #d1d5db', background: 'white', color: '#111827', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#F7F7F5', border: '2px solid #1E9E3A', borderRadius: 16, padding: 24, width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ fontWeight: 800, fontSize: 17, color: '#1E9E3A', marginBottom: 6 }}>
          📧 Email de presentación — {assignment.studentName}
        </div>
        <div style={{ height: 3, width: 48, background: '#FFC400', borderRadius: 2, marginBottom: 18 }} />

        {/* Enlace de Meet (primero) */}
        <label style={fieldLabel}>🔗 Enlace de Meet para este alumno</label>
        <input value={meetLink} onChange={e => setMeetLink(e.target.value)} placeholder="https://meet.google.com/xxx-xxxx-xxx" style={lightInput} />
        <div style={{ fontSize: 11, color: '#6b7280', margin: '5px 0 16px', lineHeight: 1.5 }}>
          Este enlace quedará guardado y se usará en el botón “Ingresar a clase” de Próximas clases.
        </div>

        {/* Para */}
        <label style={fieldLabel}>Para (email del alumno)</label>
        <input value={toEmail} onChange={e => setToEmail(e.target.value)} placeholder="alumno@email.com" style={{ ...lightInput, marginBottom: 16 }} />

        {/* Asunto */}
        <label style={fieldLabel}>Asunto</label>
        <input value={subject} onChange={e => setSubject(e.target.value)} style={{ ...lightInput, marginBottom: 16 }} />

        {/* Cuerpo */}
        <label style={fieldLabel}>Cuerpo del email</label>
        <textarea value={body} onChange={e => setBody(e.target.value)} rows={14} style={{ ...lightInput, resize: 'vertical', minHeight: 260, lineHeight: 1.5 }} />

        <div style={{ fontSize: 11, color: '#6b7280', margin: '9px 0 18px', lineHeight: 1.5 }}>
          Puedes editar el texto antes de enviarlo. Los cambios aquí no se guardan automáticamente.
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={onClose} style={{ flex: '1 1 90px', padding: '11px', borderRadius: 8, border: '1px solid #d1d5db', background: 'white', color: '#6b7280', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
            Cancelar
          </button>
          <button onClick={handleCopy} disabled={!toEmail.trim()}
            style={{ flex: '1 1 120px', padding: '11px', borderRadius: 8, border: '1.5px solid #1E9E3A', background: 'white', color: '#1E9E3A', cursor: toEmail.trim() ? 'pointer' : 'not-allowed', opacity: toEmail.trim() ? 1 : 0.5, fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
            📋 Copiar email
          </button>
          <button onClick={handleMarkSent} disabled={marking}
            style={{ flex: '2 1 180px', padding: '11px', borderRadius: 8, border: 'none', background: marking ? '#d1d5db' : '#1E9E3A', color: 'white', cursor: marking ? 'wait' : 'pointer', fontSize: 13, fontWeight: 800, fontFamily: 'inherit' }}>
            {marking ? 'Marcando…' : '✅ Marcar como enviado'}
          </button>
        </div>

        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 10, lineHeight: 1.5 }}>
          Copia el email y pégalo en Gmail. Cuando lo hayas enviado de verdad, pulsa “✅ Marcar como enviado”: copiarlo no lo marca por sí solo.
        </div>
      </div>

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: '#1E9E3A', color: 'white', padding: '10px 22px', borderRadius: 24, fontSize: 14, fontWeight: 700, zIndex: 95, boxShadow: '0 4px 16px rgba(0,0,0,0.25)' }}>
          {toast}
        </div>
      )}
    </div>
  );
}
