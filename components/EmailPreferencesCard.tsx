'use client';

// Preferencias de avisos por email del profesor.
// Opt-out: si una clave no está guardada, el aviso se envía igual, así que los
// checkboxes arrancan marcados.

import { useState } from 'react';
import { useTeachers } from '@/lib/TeachersContext';
import { EMAIL_PREF_LABELS, type EmailPreferences, type Teacher } from '@/types';

export function EmailPreferencesCard({ teacher }: { teacher: Teacher }) {
  const { updateTeacherEmailPreferences } = useTeachers();
  const [prefs, setPrefs] = useState<EmailPreferences>(teacher.emailPreferences ?? {});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isOn = (k: keyof EmailPreferences) => prefs[k] !== false;

  async function toggle(k: keyof EmailPreferences) {
    const next = { ...prefs, [k]: !isOn(k) };
    setPrefs(next);              // optimista: el checkbox responde al instante
    setSaving(k);
    setError(null);
    try {
      await updateTeacherEmailPreferences(teacher.id, next);
    } catch (err) {
      setPrefs(prefs);           // revertimos si no se pudo guardar
      setError(err instanceof Error ? err.message : 'No se pudo guardar.');
    } finally {
      setSaving(null);
    }
  }

  const destino = teacher.notificationEmail?.trim() || teacher.email;

  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 20, marginBottom: 18,
    }}>
      <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', marginBottom: 2 }}>
        Notificaciones por email
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 16 }}>
        Se envían a <strong>{destino}</strong>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {EMAIL_PREF_LABELS.map(({ key, label }) => (
          <label
            key={key}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
              cursor: saving ? 'wait' : 'pointer', fontSize: 14, color: 'var(--text-primary)',
              opacity: saving === key ? 0.55 : 1,
            }}
          >
            <input
              type="checkbox"
              checked={isOn(key)}
              disabled={saving !== null}
              onChange={() => toggle(key)}
              style={{ width: 17, height: 17, accentColor: '#1E9E3A', cursor: 'inherit', flexShrink: 0 }}
            />
            {label}
          </label>
        ))}
      </div>

      {error && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: '#B91C1C' }}>{error}</div>
      )}
    </div>
  );
}
