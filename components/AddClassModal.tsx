'use client';
// ── Modal "Añadir clase" / "Añadir transcript" ────────────────────────────────
//
// Fuente ÚNICA del flujo con el que el profesor cierra una clase dada: elegir el
// tipo, pegar el transcript de Fathom, comprobar duplicados y guardar. Lo usan:
//   · Finanzas (/mis-clases) → "Añadir clase" y "Pegar transcript" de las clases
//     a revisar (sin contexto: el profe elige alumno y fecha).
//   · Mis clases (/clases)   → botón "Añadir transcript" de una clase concreta
//     ya dada (alumno y fecha vienen fijados por la clase).
//
// El guardado vive acá también (`saveTeacherClass`) para que las dos pantallas
// escriban EXACTAMENTE lo mismo: primero el transcript (rápido, sin IA) y luego
// el análisis. El orden importa — ver lib/aiClient.registerClassWithTranscript.

import { useState, useEffect, useMemo } from 'react';
import { getSpainParts } from '@/components/VisualCalendar';
import { registerClassWithTranscript } from '@/lib/aiClient';
import { checkTranscriptDuplicates, transcriptHash, type DupeCheck } from '@/lib/transcriptDupes';
import { quickTranscriptCheck } from '@/lib/transcriptValidation';
import { canMarkStudentLostClass, LOST_CLASS_MONTHLY_CAP, LOST_CLASS_CAP_MESSAGE } from '@/lib/finance';
import type { Teacher, Assignment, ClassRecord, ClassRecordType } from '@/types';

// Opciones del selector "Tipo de clase".
const CLASS_TYPE_OPTIONS: Array<{ value: ClassRecordType; label: string; needsTranscript: boolean }> = [
  { value: 'normal',           label: 'Clase normal',                needsTranscript: true },
  { value: 'falta_sin_aviso',  label: 'Falta del alumno sin aviso',  needsTranscript: false },
  { value: 'cancelacion_hora', label: 'Cancelación sobre la hora',    needsTranscript: false },
  { value: 'recuperacion',     label: 'Clase de recuperación',        needsTranscript: true },
];

const MONTHS_SHORT = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
function shortDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS_SHORT[d.getMonth()]}`;
}

const DAY_NAMES = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];

// ── Guardado: transcript primero, análisis después ────────────────────────────

export type RegisterClassRecordFn = (
  teacherId: string, studentName: string, date: string, time: string | undefined,
  screenshotFile: File | null, classType?: ClassRecordType, comment?: string,
  recoveryForDate?: string,
) => Promise<void>;

export interface SaveClassArgs {
  teacher: Teacher;
  myAssignments: Assignment[];
  studentName: string;
  date: string;
  time?: string;
  transcript: string;
  classType: ClassRecordType;
  comment: string;
  transcriptHash: string;
  replaceId: string | null;
  registerClassRecord: RegisterClassRecordFn;
  /**
   * Ingreso ("Ingresar a clase") al que pertenece este transcript. Cuando viene,
   * el vínculo con la clase es EXPLÍCITO y manda sobre la fecha: finanzas empareja
   * transcript e ingreso por id en vez de adivinar por proximidad de fechas, que
   * es lo que fallaba cuando un alumno tenía clases en días seguidos.
   */
  joinLogId?: string | null;
  /**
   * Duración de la clase en horas. Una sesión de 2 celdas contiguas manda 2: el
   * transcript cubre las dos horas y la validación se calibra con esa duración.
   */
  durationHours?: number;
  /**
   * Fecha de la clase PERDIDA que esta sesión salda ('YYYY-MM-DD'). La manda el
   * bloque de 2h "normal + recuperación": se guarda como clase 'normal' (es lo
   * que es su hora principal) pero deja el vínculo con la clase que repone, para
   * que el historial del alumno lo conserve cuando la celda del calendario ya no
   * esté. Ausente en una clase normal: entonces no cambia absolutamente nada.
   */
  recoveryForDate?: string;
}

export interface SaveClassResult {
  /** Aviso a mostrar en pantalla en cuanto termina el guardado. */
  notice: { title: string; body: string } | null;
  /** Informe de IA todavía en curso. null si la clase no llevaba transcript. */
  analysis: Promise<{ analyzed: boolean; error?: string }> | null;
}

/**
 * Guarda una clase dada:
 *   1) el registro en class_records (tipo, hora, comentario), sin captura.
 *   2) si el tipo requiere transcript, se GUARDA en class_analyses (segundo
 *      factor de verificación de finanzas) y recién después se analiza con IA.
 *
 * El orden importa: antes se analizaba primero y, si la IA fallaba o tardaba, la
 * clase no llegaba a registrarse y el profesor la perdía. Ahora el guardado no
 * depende de la IA, y la validación nunca cancela nada: como mucho deja la clase
 * pendiente de revisión del equipo.
 */
export async function saveTeacherClass(args: SaveClassArgs): Promise<SaveClassResult> {
  const {
    teacher, myAssignments, studentName, date, time, transcript, classType, comment,
    transcriptHash: hash, replaceId, registerClassRecord, joinLogId, durationHours, recoveryForDate,
  } = args;

  // Faltas/cancelaciones (sin transcript): solo la constancia.
  if (!transcript.trim()) {
    if (!replaceId) await registerClassRecord(teacher.id, studentName, date, time, null, classType, comment, recoveryForDate);
    return { notice: null, analysis: null };
  }

  const asgn = myAssignments.find(a => a.studentName === studentName);
  const result = await registerClassWithTranscript({
    transcript: transcript.trim(),
    studentName,
    teacherName: teacher.name,
    studentId: asgn?.studentId ?? null,
    teacherId: teacher.id,
    plan: asgn?.plan ?? null,
    level: asgn?.studentLevel ?? null,
    classDate: date,
    transcriptHash: hash || null,
    replaceId,
    joinLogId: joinLogId ?? null,
    durationMinutes: durationHours && durationHours > 1 ? durationHours * 60 : null,
  });

  if (!replaceId) {
    await registerClassRecord(teacher.id, studentName, date, time, null, classType, comment, recoveryForDate);
  }

  // La clase ya está guardada y validada acá; el informe de IA va por detrás.
  const notice = result.validation && result.validation.decision !== 'ok'
    ? { title: result.validation.teacherTitle, body: result.validation.teacherBody }
    : {
        title: 'Clase guardada ✓',
        body: 'La clase quedó registrada y cuenta para tu pago. El análisis se completará en unos instantes; no hace falta que esperes.',
      };

  return { notice, analysis: result.analysis };
}

/** Aviso estándar cuando el informe de IA falla (la clase igual está guardada). */
export const ANALYSIS_FAILED_NOTICE = {
  title: 'Análisis pendiente',
  body: 'La clase quedó registrada y cuenta para tu pago. El informe de IA no se pudo generar; puedes reintentarlo desde la ficha del alumno, en Seguimiento.',
};

// ── Aviso de transcript duplicado ─────────────────────────────────────────────
/**
 * Dos casos, y NINGUNO impide guardar:
 *   · duplicate → texto EXACTAMENTE igual a otro de este alumno: se avisa por si
 *                 fue un pegado por error, y se puede subir igual.
 *   · replace   → ya hay transcript de esta clase: se ofrece reemplazarlo.
 *
 * Un transcript parecido pero no idéntico es otra clase: no se dice nada.
 */
function DuplicateDialog({ check, onCancel, onConfirm }: {
  check: DupeCheck; onCancel: () => void; onConfirm: () => void;
}) {
  if (check.kind === 'none') return null;

  const when = check.row.class_date ? shortDate(check.row.class_date) : 'fecha desconocida';

  const copy = check.kind === 'duplicate'
    ? {
        title: 'Este transcript es idéntico a uno ya subido',
        body: `Este transcript es idéntico a uno que ya subiste para ${check.row.student_name} el ${when}. Si es correcto y querés subirlo de todos modos, confirmá.`,
        confirm: 'Subir de todos modos',
      }
    : {
        title: 'Ya existe un transcript para esta clase',
        body: `Registraste una clase con ${check.row.student_name} el ${when}. ¿Querés reemplazar el transcript existente? Se volverá a analizar con el texto nuevo.`,
        confirm: 'Reemplazar',
      };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
      role="alertdialog"
      aria-modal="true"
    >
      <div style={{ background: '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 420 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#e0912f' }} />
          <span style={{ fontSize: 16, fontWeight: 700, color: '#1a1c1a' }}>{copy.title}</span>
        </div>
        <p style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.65, margin: '0 0 18px' }}>{copy.body}</p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onCancel}
            style={{ flex: 1, padding: '10px', borderRadius: 9, border: '1px solid var(--border)', background: 'transparent', color: '#5f6360', cursor: 'pointer', fontSize: 13.5, fontFamily: 'inherit' }}
          >
            Cancelar
          </button>
          {copy.confirm && (
            <button
              onClick={onConfirm}
              style={{ flex: 2, padding: '10px', borderRadius: 9, border: 'none', background: '#1E9E3A', color: '#fff', cursor: 'pointer', fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit' }}
            >
              {copy.confirm}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────────────

export interface AddClassInitial {
  studentName: string;
  date: string;
  classType: ClassRecordType;
  /** Hora de la clase, 'HH:MM'. Si no viene se autocompleta desde el horario. */
  time?: string;
}

export interface AddClassModalProps {
  teacher: Teacher;
  myAssignments: Assignment[];
  classRecords: ClassRecord[];
  /** Prefill: deja alumno/fecha/tipo ya puestos para que el profe solo pegue el texto. */
  initial?: AddClassInitial | null;
  /** Título del modal. Por defecto "Añadir clase". */
  title?: string;
  /**
   * El modal se abrió DESDE una clase concreta: alumno y fecha son esa clase y no
   * se pueden cambiar (cambiarlos pegaría el transcript en la clase equivocada).
   */
  lockClass?: boolean;
  /**
   * El tipo de clase ya se eligió antes de abrir el modal: se muestra, no se
   * puede cambiar. Lo usa la pantalla de solicitudes de revisión, donde el
   * profesor elige el tipo primero y este modal solo recoge el transcript.
   */
  lockType?: boolean;
  /** Texto del botón de guardado. Por defecto "Guardar registro". */
  submitLabel?: string;
  /** Texto del recuadro verde de contexto. Si no viene, se usa el de Finanzas. */
  contextNote?: React.ReactNode;
  /**
   * Duración de la clase en horas (2 en una sesión de celdas contiguas). Calibra
   * el aviso de "esto parece el resumen": una clase de 2h espera más texto.
   */
  durationHours?: number;
  onClose: () => void;
  onSaved: (
    studentName: string, date: string, time: string | undefined, transcript: string,
    classType: ClassRecordType, comment: string,
    transcriptHash: string, replaceId: string | null,
  ) => Promise<void>;
}

export function AddClassModal({
  teacher, myAssignments, classRecords, initial, title, lockClass, lockType, contextNote,
  durationHours, submitLabel, onClose, onSaved,
}: AddClassModalProps) {
  // Se extrae a una variable para que el memo dependa del nombre y no del objeto
  // `initial` entero (que el llamador puede recrear en cada render).
  const initialStudent = initial?.studentName;
  const studentOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const a of myAssignments) {
      if (!seen.has(a.studentName)) { seen.add(a.studentName); out.push(a.studentName); }
    }
    out.sort((x, y) => x.localeCompare(y));
    // Ex-alumno sin assignment activa: si venimos de una clase suya, debe poder
    // seleccionarse igual para pegarle el transcript.
    if (initialStudent && !seen.has(initialStudent)) out.unshift(initialStudent);
    return out;
  }, [myAssignments, initialStudent]);

  const todayIso = getSpainParts(new Date()).dateStr;
  const [studentName, setStudentName] = useState(initial?.studentName ?? studentOptions[0] ?? '');
  const [date, setDate] = useState(initial?.date ?? todayIso);
  const [time, setTime] = useState(initial?.time ?? '');
  const [transcript, setTranscript] = useState('');
  const [classType, setClassType] = useState<ClassRecordType>(initial?.classType ?? 'normal');
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  // Duplicado detectado a la espera de decisión del profesor.
  const [dupe, setDupe] = useState<{ check: DupeCheck; hash: string } | null>(null);

  const needsTranscript = CLASS_TYPE_OPTIONS.find(o => o.value === classType)?.needsTranscript ?? true;
  const isFaltaType = classType === 'falta_sin_aviso' || classType === 'cancelacion_hora';

  // Cuántas CLASES PERDIDAS lleva ya el alumno ese mes. Un solo tope para los dos
  // tipos: la falta y la cancelación sobre la hora comparten los 2 del mes, con el
  // mismo contador que usan el botón de finanzas y el cálculo del pago
  // (canMarkStudentLostClass, lib/finance), para que no puedan discrepar.
  const typeCount = useMemo(() => {
    if (!isFaltaType) return 0;
    return canMarkStudentLostClass(classRecords, teacher.id, studentName, (date || '').slice(0, 7)).count;
  }, [classRecords, teacher.id, studentName, isFaltaType, date]);
  const limitReached = isFaltaType && typeCount >= LOST_CLASS_MONTHLY_CAP;

  // Auto-rellenar la hora con el slot recurrente del alumno si el día coincide.
  // Depende solo de alumno+fecha para no pisar una hora editada a mano. Si el
  // llamador ya pasó la hora de la clase concreta, no hay nada que adivinar.
  useEffect(() => {
    if (initial?.time) return;
    if (!studentName || !date) return;
    const dayName = DAY_NAMES[new Date(date + 'T00:00:00').getDay()];
    for (const a of myAssignments.filter(a => a.studentName === studentName)) {
      const slot = (a.slots ?? []).find(s => s.day === dayName);
      if (slot) { setTime(slot.hour.length === 5 ? slot.hour : `${slot.hour.padStart(2, '0')}:00`); return; }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentName, date]);

  // Aviso PREVIO: las dos señales que mandan un transcript a la cola de revisión
  // y que el profesor puede corregir en el momento (pegar el texto completo con
  // marcas de tiempo en vez del resumen). Comparte umbrales con el validador.
  const quick = useMemo(
    () => quickTranscriptCheck(transcript, { durationMinutes: (durationHours ?? 1) * 60 }),
    [transcript, durationHours],
  );

  // Normal/recuperación: TRANSCRIPT obligatorio (segundo factor de verificación).
  // Falta/cancelación: comentario obligatorio y bloqueado al llegar a 2 de ese tipo.
  const words = transcript.trim() ? transcript.trim().split(/\s+/).length : 0;
  const canSave = !!studentName && !!date && !saving && !limitReached &&
    (needsTranscript ? words >= 30 : !!comment.trim());

  // Guardado real. `replaceId` llega solo cuando el profesor confirmó reemplazar
  // el transcript de una clase ya registrada.
  async function persist(hash: string, replaceId: string | null) {
    setSaving(true); setError('');
    try {
      await onSaved(
        studentName, date, time || undefined,
        needsTranscript ? transcript.trim() : '',
        classType, comment.trim(), hash, replaceId,
      );
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar el registro.');
      setSaving(false);
    }
  }

  async function handleSave() {
    if (!canSave) return;

    // Las faltas/cancelaciones no llevan transcript: nada que verificar.
    if (!needsTranscript) { await persist('', null); return; }

    const hash = await transcriptHash(transcript);
    setChecking(true);
    let result: DupeCheck;
    try {
      result = await checkTranscriptDuplicates({
        teacherId: teacher.id, studentName, classDate: date, hash,
      });
    } catch {
      result = { kind: 'none' };   // la verificación nunca debe impedir guardar
    } finally {
      setChecking(false);
    }

    if (result.kind === 'none') { await persist(hash, null); return; }
    setDupe({ check: result, hash });
  }

  const inputStyle = { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1.5px solid var(--border)', fontSize: 13, background: 'white', color: '#111827', fontFamily: 'inherit', boxSizing: 'border-box' as const };
  const labelStyle = { fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 } as const;
  const readOnlyStyle = { ...inputStyle, background: '#f0f1ee', color: '#5f6360', fontWeight: 600 };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div style={{ background: '#F7F7F5', border: '1px solid var(--border)', borderRadius: 16, width: '100%', maxWidth: 440, maxHeight: '92vh', overflowY: 'auto', padding: 26 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div style={{ fontWeight: 700, fontSize: 17, color: '#111827' }}>{title ?? 'Añadir clase'}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }}>✕</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {initial && (
            <div style={{ fontSize: 12, color: '#1f7a3d', background: 'rgba(30,158,58,0.08)', border: '1px solid rgba(30,158,58,0.28)', borderRadius: 8, padding: '9px 12px', lineHeight: 1.5 }}>
              {contextNote ?? (
                <>Completa esta clase a revisar: pega el transcript de <b>{initial.studentName}</b> del <b>{shortDate(initial.date)}</b> para verificarla.</>
              )}
            </div>
          )}
          <div>
            <label style={labelStyle}>Alumno</label>
            {lockClass ? (
              <div style={readOnlyStyle}>{studentName}</div>
            ) : studentOptions.length === 0 ? (
              <div style={{ fontSize: 12, color: '#b45309' }}>No tienes alumnos asignados.</div>
            ) : (
              <select value={studentName} onChange={e => setStudentName(e.target.value)} style={inputStyle}>
                {studentOptions.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
          </div>
          <div>
            <label style={labelStyle}>Tipo de clase <span style={{ color: '#ef4444' }}>*</span></label>
            {lockType ? (
              <div style={readOnlyStyle}>
                {CLASS_TYPE_OPTIONS.find(o => o.value === classType)?.label ?? classType}
              </div>
            ) : (
              <select value={classType} onChange={e => setClassType(e.target.value as ClassRecordType)} style={inputStyle}>
                {CLASS_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            )}
          </div>
          {limitReached ? (
            <>
              <div style={{ fontSize: 13, color: '#dc2626', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 10, padding: '12px 14px', lineHeight: 1.5 }}>
                {LOST_CLASS_CAP_MESSAGE}
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
                <button onClick={onClose} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#6b7280', cursor: 'pointer', fontSize: 14, fontFamily: 'inherit' }}>Cerrar</button>
              </div>
            </>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={labelStyle}>Fecha de la clase</label>
                  {lockClass
                    ? <div style={readOnlyStyle}>{shortDate(date)}</div>
                    : <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />}
                </div>
                <div>
                  <label style={labelStyle}>Hora (España)</label>
                  <input type="time" value={time} onChange={e => setTime(e.target.value)} style={inputStyle} />
                </div>
              </div>
              {needsTranscript ? (
                <div>
                  <label style={labelStyle}>
                    Transcript de la clase <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <textarea
                    value={transcript}
                    onChange={e => { setTranscript(e.target.value); setError(''); }}
                    rows={6}
                    placeholder="Pega aquí el texto que genera Fathom al terminar la sesión..."
                    style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }}
                  />
                  <div style={{ fontSize: 11, color: words >= 30 ? '#1E9E3A' : '#6b7280', marginTop: 5 }}>
                    {words} palabras{words < 30 ? ' · mínimo 30' : ''}
                    {quick.timestamps > 0 && ` · ${quick.timestamps} marcas de tiempo`}
                  </div>

                  {/* Aviso ANTES de guardar. No bloquea (nunca se le impide
                      registrar la clase): le dice qué va a pasar si guarda esto,
                      que es justo lo que nadie le decía y llenó la cola de
                      revisión con clases que él daba por entregadas. */}
                  {/* Dispara por LONGITUD, no por falta de marcas de tiempo: un
                      transcript largo sin marcas es un caso real y frecuente (el
                      profe copia solo el texto), y avisar ahí sería ruido que
                      enseña a ignorar el aviso. Medido sobre las 98 clases reales:
                      así se marcan 19 de las 20 que acabaron en revisión. */}
                  {words >= 30 && quick.tooShort && (
                    <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.55, color: '#8a6d00', background: 'rgba(255,196,0,0.12)', border: '1px solid rgba(255,196,0,0.5)', borderRadius: 8, padding: '9px 11px' }}>
                      <b style={{ color: '#7a6000' }}>
                        {quick.looksLikeSummary
                          ? 'Esto parece el RESUMEN de Fathom, no la transcripción'
                          : 'El texto es más corto de lo esperable'}
                      </b>
                      <div style={{ marginTop: 3 }}>
                        Son {quick.words} palabras y una clase
                        de {durationHours && durationHours > 1 ? `${durationHours} h` : '60 min'} suele
                        tener {quick.minWords}+.{quick.noTimestamps && ' Tampoco se ven marcas de tiempo (0:00, 12:34).'}{' '}
                        En Fathom, abrí la pestaña <b>Transcript</b> y copiá el texto completo — no el <i>Summary</i> ni las notas.
                      </div>
                      <div style={{ marginTop: 5, color: '#7a6000' }}>
                        Podés guardarlo igual, pero irá a <b>revisión del equipo</b> y no contará para tu pago hasta que lo validen.
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 11.5, color: '#b45309', background: 'rgba(255,196,0,0.1)', border: '1px solid rgba(255,196,0,0.3)', borderRadius: 8, padding: '8px 10px', lineHeight: 1.5 }}>
                  Este tipo de clase <b>SÍ genera cobro</b> (tarifa normal del alumno) y <b>no te penaliza</b>:
                  el que faltó fue el alumno. Se cobran hasta {LOST_CLASS_MONTHLY_CAP} clases perdidas <b>por mes</b>
                  {' '}—faltas y cancelaciones sobre la hora juntas—; llevás <b>{typeCount}</b> de {LOST_CLASS_MONTHLY_CAP} este
                  mes, y la clase consume cupo del alumno. No requiere transcript.
                </div>
              )}
              <div>
                <label style={labelStyle}>
                  Comentario {needsTranscript ? '(opcional)' : <span style={{ color: '#ef4444' }}>*</span>}
                </label>
                <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2}
                  placeholder={needsTranscript ? 'Ej: el alumno llegó tarde...' : 'Detallá el motivo (obligatorio)'}
                  style={{ ...inputStyle, resize: 'vertical' }} />
              </div>
              {error && <div style={{ fontSize: 12, color: '#ef4444' }}>{error}</div>}
              <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
                <button onClick={onClose} disabled={saving} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#6b7280', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 14, fontFamily: 'inherit' }}>Cancelar</button>
                <button onClick={handleSave} disabled={!canSave || checking} style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: canSave && !checking ? '#1E9E3A' : '#d1d5db', color: 'white', cursor: canSave && !checking ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 700, fontFamily: 'inherit' }}>
                  {checking ? 'Verificando...' : saving ? 'Guardando...' : (submitLabel ?? 'Guardar registro')}
                </button>
              </div>
            </>
          )}
        </div>

        {dupe && (
          <DuplicateDialog
            check={dupe.check}
            onCancel={() => setDupe(null)}
            onConfirm={() => {
              const replaceId = dupe.check.kind === 'replace' ? dupe.check.row.id : null;
              setDupe(null);
              persist(dupe.hash, replaceId);
            }}
          />
        )}
      </div>
    </div>
  );
}

export default AddClassModal;
