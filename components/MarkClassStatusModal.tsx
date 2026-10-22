'use client';
// ── "Marcar estado": qué pasó en una clase ya terminada ───────────────────────
//
// Las siete respuestas de lib/classStatus. Este modal NO guarda nada por su
// cuenta: dice qué eligió el profesor y el panel lo lleva al flujo que ya
// existe para eso (components/MisClasesPanel):
//   · Realizada / Recuperada          → subir el transcript
//   · No se conectó / canceló < 24 h  → la misma constancia de "Añadir clase"
//                                       (con su tope de 2 clases perdidas al mes)
//   · Canceló con más de 24 h         → constancia 'falta_con_aviso'
//   · Estuve ausente                  → falta del profesor (servidor)
// "Cancelada por el profe" no se puede marcar después: sale sola de «No puedo
// dar esta clase», que se usa ANTES de la clase.

import { useState } from 'react';
import { CLASS_STATUS_LABEL, type ClassStatus } from '@/lib/classStatus';
import { FALTA_PENALTY_EUROS } from '@/lib/teacherPenalties';
import { fmtDateDMY } from '@/lib/teacherClasses';

export type MarkableStatus = Exclude<ClassStatus, 'cancelada_profesor'>;

interface Option {
  value: ClassStatus;
  label: string;
  help: string;
  disabled?: string;
}

export function MarkClassStatusModal({ studentName, date, hourLabel, isRecovery, hasJoin, onChoose, onClose }: {
  studentName: string;
  date: string;
  hourLabel: string;
  isRecovery: boolean;
  /** Pulsó "Ingresar a clase": entonces no puede declararse ausente. */
  hasJoin: boolean;
  /** Se resuelve cuando la acción terminó; si lanza, el error se muestra aquí. */
  onChoose: (status: MarkableStatus) => Promise<void> | void;
  onClose: () => void;
}) {
  const [choice, setChoice] = useState<ClassStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const options: Option[] = [
    isRecovery
      ? { value: 'recuperada', label: CLASS_STATUS_LABEL.recuperada, help: 'Diste la recuperación. Se marca al subir el transcript.' }
      : { value: 'realizada', label: CLASS_STATUS_LABEL.realizada, help: 'Diste la clase. Se marca al subir el transcript.' },
    { value: 'cancelada_alumno_antelacion', label: CLASS_STATUS_LABEL.cancelada_alumno_antelacion, help: 'No se paga y no te penaliza. La clase queda pendiente de recuperar.' },
    { value: 'cancelada_alumno_tarde', label: CLASS_STATUS_LABEL.cancelada_alumno_tarde, help: 'Se da por realizada: se te paga y gasta una clase del alumno (máximo 2 al mes entre faltas y cancelaciones).' },
    { value: 'alumno_no_conecto', label: CLASS_STATUS_LABEL.alumno_no_conecto, help: 'Se da por realizada: se te paga y gasta una clase del alumno (máximo 2 al mes entre faltas y cancelaciones).' },
    { value: 'cancelada_profesor', label: CLASS_STATUS_LABEL.cancelada_profesor, help: '', disabled: 'Solo con «No puedo dar esta clase», antes de la clase. Si no avisaste, elige «Estuve ausente».' },
    {
      value: 'profesor_ausente', label: 'Estuve ausente',
      help: `Cuenta como falta: −${FALTA_PENALTY_EUROS} € y el alumno recibe una recuperación.`,
      disabled: hasJoin ? 'Pulsaste «Ingresar a clase» en esta clase.' : undefined,
    },
  ];

  async function confirm() {
    if (!choice || choice === 'cancelada_profesor' || saving) return;
    setSaving(true);
    setError('');
    try {
      await onChoose(choice);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar. Inténtalo de nuevo.');
      setSaving(false);
    }
  }

  const ausente = choice === 'profesor_ausente';

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="estado-clase-title"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 22, width: '100%', maxWidth: 460, maxHeight: '88vh', overflowY: 'auto' }}>
        <div id="estado-clase-title" style={{ fontWeight: 700, fontSize: 17, color: 'var(--text-primary)', marginBottom: 4 }}>
          ¿Qué pasó en esta clase?
        </div>
        <div style={{ fontSize: 13.5, color: 'var(--text-secondary)', marginBottom: 16 }}>
          {studentName} · {fmtDateDMY(date)} · {hourLabel}
        </div>

        <div role="radiogroup" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {options.map(o => {
            const selected = choice === o.value;
            return (
              <label key={o.value}
                style={{
                  display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10,
                  border: `1.5px solid ${selected ? '#1E9E3A' : 'var(--border)'}`,
                  background: o.disabled ? 'var(--bg-surface-3, #f4f4f2)' : selected ? 'rgba(30,158,58,0.06)' : '#fff',
                  cursor: o.disabled ? 'not-allowed' : 'pointer', opacity: o.disabled ? 0.7 : 1,
                }}>
                <input type="radio" name="estado-clase" value={o.value} checked={selected} disabled={!!o.disabled || saving}
                  onChange={() => setChoice(o.value)} style={{ marginTop: 3 }} />
                <span>
                  <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{o.label}</span>
                  <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5, marginTop: 2 }}>
                    {o.disabled ?? o.help}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        {error && (
          <div role="alert" style={{ fontSize: 13, color: '#b91c1c', background: 'rgba(239,68,68,0.06)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} disabled={saving}
            style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: '#fff', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
            Cancelar
          </button>
          <button onClick={confirm} disabled={!choice || saving}
            style={{
              flex: 2, padding: '10px', borderRadius: 8, border: 'none', cursor: choice && !saving ? 'pointer' : 'not-allowed',
              background: ausente ? '#b42318' : '#1E9E3A', color: '#fff', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
              opacity: choice && !saving ? 1 : 0.6,
            }}>
            {saving ? 'Guardando…' : ausente ? `Confirmar falta (−${FALTA_PENALTY_EUROS} €)` : 'Continuar'}
          </button>
        </div>
      </div>
    </div>
  );
}
