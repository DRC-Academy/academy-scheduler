'use client';

// Confirmación del nivel CEFR por el PROFESOR: el respaldo humano a la prueba
// automática.
//
// Por qué existe: la prueba de nivel puntúa al alumno el primer día, con una
// lectura adaptativa y un writing. Tras 2-3 clases el profesor tiene mejor
// criterio que ese examen. Este control le deja fijarlo sin borrar el de la
// prueba, que queda guardado aparte para poder medir después cuánto acierta.
//
// Se muestra SIEMPRE, haya prueba o no. La mayoría de los alumnos nunca la hizo,
// y son justamente los que más falta les hace una corrección: su único nivel es
// el que tipeó el setter al darlos de alta. Cuando no hay prueba, la referencia
// que se enseña es esa, rotulada como lo que es.

import { useState } from 'react';
import { CEFR_COLOR } from '@/lib/levelTest/constants';
import { referenceLevelOf, teacherReviewOf, type TeacherReviewFields } from '@/lib/effectiveLevel';

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;

/** Rótulo de la referencia según de dónde salga. El profesor tiene que saber
 *  contra qué está comparando: no es lo mismo un examen que un campo del alta. */
const REFERENCE_LABEL: Record<string, string> = {
  prueba: 'Nivel según la prueba',
  ficha:  'Nivel según la ficha',
  alta:   'Nivel del alta',
};

interface Props {
  profile: (TeacherReviewFields & {
    id?: string | null;
    student_id?: string | null;
    level_test_completed_at?: string | null;
    teacher_confirmed_at?: string | null;
    teacher_confirmed_by?: string | null;
  }) | null;
  assignmentLevel: string | null | undefined;
  studentName: string;
  studentId: string | null;
  teacherId: string | null;
  teacherName: string;
  /** Recarga los bundles: sin esto la escalera CEFR de arriba seguiría con el
   *  nivel viejo hasta que el profesor recargara la página a mano. */
  onSaved: (level: string | null) => void | Promise<void>;
}

export default function NivelProfesorCard(p: Props) {
  const confirmed = p.profile?.teacher_confirmed_level ?? null;
  const reference = referenceLevelOf(p.profile, p.assignmentLevel);

  // El desplegable arranca en lo que el profesor ya dijo; si nunca dijo nada,
  // en el nivel de referencia, que es la respuesta más probable ("lo confirmo").
  // Vacío solo cuando no hay ninguna referencia reconocible.
  const [value, setValue] = useState<string>(() => confirmed || reference.level || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  // La ficha se recarga tras guardar, y al pasar al alumno siguiente el
  // componente NO se desmonta (misma ruta, otro parámetro): el desplegable tiene
  // que seguir al dato en vez de quedarse con lo que había cuando se montó.
  //
  // Se ajusta DURANTE el render, no en un useEffect: con el efecto, React pinta
  // primero un fotograma con el valor viejo y vuelve a renderizar
  // (react-hooks/set-state-in-effect). Ver "You Might Not Need an Effect".
  const syncKey = `${confirmed ?? ''}|${reference.level ?? ''}`;
  const [lastSync, setLastSync] = useState(syncKey);
  if (lastSync !== syncKey) {
    setLastSync(syncKey);
    setValue(confirmed || reference.level || '');
    setError(null);
  }

  const review = teacherReviewOf(p.profile, p.assignmentLevel);

  // Qué haría el botón AHORA MISMO con lo que hay elegido.
  //
  // El problema que esto arregla: cuando el profesor estaba de acuerdo, el
  // desplegable ya venía con el nivel de la prueba, la referencia de al lado
  // decía lo mismo y el botón decía "Guardar". Parecía que no había nada que
  // hacer, y nadie pulsa un botón que aparentemente no cambia nada. Resultado:
  // en agosto de 2026, de 15 alumnos con prueba solo 2 tenían nivel del
  // profesor, y los DOS eran correcciones. El acuerdo —que es la mitad del set
  // de calibración— no se registraba nunca.
  //
  // Ahora el botón dice lo que hace y sigue activo cuando el nivel coincide:
  // confirmar el acuerdo es una acción, no la ausencia de una.
  const yaGuardado = value === (confirmed || '');
  const coincide = !!value && value === reference.level;
  const accion: 'confirmar' | 'corregir' | 'nada' =
    !value || yaGuardado ? 'nada' : coincide ? 'confirmar' : 'corregir';
  const btnLabel = saving ? 'Guardando…' : accion === 'corregir' ? 'Guardar corrección' : 'Confirmar nivel';
  const btnOff = saving || accion === 'nada';

  async function save(level: string | null) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/students/confirm-level', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profileId:   p.profile?.id ?? null,
          studentId:   p.studentId,
          studentName: p.studentName,
          teacherId:   p.teacherId,
          teacherName: p.teacherName,
          level,
          against: reference.level,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) throw new Error(data?.error || 'No se pudo guardar el nivel.');
      setJustSaved(true);
      await p.onSaved(level);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar el nivel.');
    } finally {
      setSaving(false);
    }
  }

  const refColor = reference.level
    ? (CEFR_COLOR[reference.level as keyof typeof CEFR_COLOR] || 'var(--text-primary)')
    : 'var(--text-muted)';
  const confColor = confirmed
    ? (CEFR_COLOR[confirmed as keyof typeof CEFR_COLOR] || 'var(--text-primary)')
    : 'var(--text-muted)';

  const refLabel = reference.origin ? (REFERENCE_LABEL[reference.origin] ?? 'Nivel de referencia') : null;
  const refDate = reference.origin === 'prueba' && p.profile?.level_test_completed_at
    ? new Date(p.profile.level_test_completed_at).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;
  const confDate = p.profile?.teacher_confirmed_at
    ? new Date(p.profile.teacher_confirmed_at).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;

  return (
    <div
      data-onboarding="nivel-profesor"
      style={{
        marginTop: 14, borderRadius: 12, padding: '14px 16px',
        border: `1px solid ${confirmed ? 'rgba(30,158,58,0.35)' : 'var(--border)'}`,
        background: confirmed ? 'rgba(30,158,58,0.05)' : 'var(--bg-surface)',
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Nivel real del alumno
      </div>

      <p style={{ margin: '6px 0 12px', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        Tras las primeras clases, dinos si el nivel de al lado es el correcto.
        <b> Confírmalo aunque estés de acuerdo</b>: así sabemos cuándo la prueba acierta, no
        solo cuándo falla. Tu criterio es el que manda de aquí en adelante — en la ficha, en
        las clases que genera la IA y en el progreso que ve el alumno.
      </p>

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {/* Referencia: dato, no control. Es contra lo que el profesor contrasta. */}
        <div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 3 }}>
            {refLabel ?? 'Sin nivel previo'}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
            <span style={{ fontSize: 20, fontWeight: 700, color: refColor }}>
              {reference.level ?? reference.raw ?? '—'}
            </span>
            {refDate && <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{refDate}</span>}
            {reference.origin === 'alta' && (
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>· sin prueba de nivel</span>
            )}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 220 }}>
          <label htmlFor="nivel-profesor-select" style={{ display: 'block', fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 3 }}>
            Nivel real que observas
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select
              id="nivel-profesor-select"
              value={value}
              disabled={saving}
              onChange={e => { setValue(e.target.value); setJustSaved(false); }}
              style={{
                padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)',
                background: 'var(--bg-surface)', color: 'var(--text-primary)',
                fontSize: 14, fontFamily: 'inherit', fontWeight: 600, minWidth: 92,
              }}
            >
              <option value="">Elegir…</option>
              {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <button
              type="button"
              disabled={btnOff}
              onClick={() => save(value)}
              style={{
                padding: '8px 18px', borderRadius: 8, border: 'none',
                cursor: btnOff ? 'default' : 'pointer',
                background: btnOff ? '#d8dad6' : '#1E9E3A',
                color: btnOff ? '#6b6f6a' : 'white',
                fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit',
              }}
            >
              {btnLabel}
            </button>
          </div>
        </div>
      </div>

      {/* LOS TRES ESTADOS, dichos con todas las letras. El que faltaba era el
          primero: "confirmado igual" antes no se distinguía de "sin revisar",
          porque las dos cosas dejaban el campo vacío. */}
      {yaGuardado && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {review.state === 'sin_revisar' ? (
            <span style={{ color: 'var(--text-muted)' }}>
              <b>Sin revisar.</b> Si el nivel de arriba te cuadra, confírmalo: saber que acertó
              vale tanto como saber que se equivocó.
            </span>
          ) : (
            <>
              <span style={{ color: confColor, fontWeight: 700 }}>{confirmed}</span>
              {review.state === 'confirmado'
                ? <> confirmado{review.against ? <> — coincide con el nivel de {review.against === reference.level && reference.origin === 'prueba' ? 'la prueba' : 'referencia'}</> : ''}</>
                : <> corregido{review.against ? <>, la referencia decía <b>{review.against}</b></> : ''}</>}
              {p.profile?.teacher_confirmed_by ? ` · ${p.profile.teacher_confirmed_by}` : ''}
              {confDate ? ` · ${confDate}` : ''}.
              {' '}
              <button
                type="button"
                disabled={saving}
                onClick={() => save(null)}
                style={{
                  border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                  color: 'var(--text-muted)', fontSize: 12.5, fontFamily: 'inherit', textDecoration: 'underline',
                }}
              >
                Quitar mi confirmación
              </button>
            </>
          )}
        </div>
      )}

      {justSaved && yaGuardado && !error && (
        <div style={{ marginTop: 8, fontSize: 12.5, color: '#1E9E3A', fontWeight: 600 }}>Guardado.</div>
      )}
      {error && (
        <div style={{ marginTop: 8, fontSize: 12.5, color: '#b42318', lineHeight: 1.5 }}>{error}</div>
      )}
    </div>
  );
}
