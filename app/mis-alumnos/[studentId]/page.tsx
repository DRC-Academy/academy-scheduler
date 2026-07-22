'use client';

// Página completa del alumno. Sustituye al popup de "Ver ficha" y a las tabs
// que StudentCard mostraba en línea dentro de la lista.
//
// El identificador de la URL puede ser el student_id real o, si el alumno no lo
// tiene, el id de la assignment: se resuelve contra las dos cosas.

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { HelpTooltip } from '@/components/ui';
import { calcRegisteredClassNumber } from '@/lib/db';
import { loadStudentBundles, norm, type StudentBundle } from '@/lib/misAlumnos';
import { regenerateFicha } from '@/lib/aiClient';
import { getProgressLink } from '@/lib/progressClient';
import { getOrCreateFormLink } from '@/lib/formClient';
import { analyzeTranscriptOnly, saveAnalysis } from '@/lib/aiClient';
import { checkTranscriptDuplicates, transcriptHash, type DupeCheck } from '@/lib/transcriptDupes';
import { pendingClassesFor, type PendingClass } from '@/lib/pendingClasses';
import type { Assignment } from '@/types';
import type { StudentProfileRow } from '@/lib/aiTypes';
import {
  cefrSteps, milestoneProgress, skillsFromResponses, type SkillGauge,
} from '@/lib/studentViz';
import { classCategoryBadge } from '@/lib/finance';
import { FORM_QUESTIONS } from '@/lib/formQuestions';
import {
  asObject, fichaFromRow, isRiskSignal,
  type ClassAnalysisRow, type FichaIA, type GeneratedClassIA, type NextClassGuide, type RiskSignal,
} from '@/lib/aiTypes';
import ProximaClaseTab from '@/components/alumnos/ProximaClaseTab';
import {
  Accordion, BulletList, ClampText, ProgressCompare, toBullets,
} from '@/components/alumnos/studentPageUi';
import {
  RiskDot, RISK_TEXT, Tabs, Toast, btnPrimary, btnSecondary, formatDate, relativeDays,
  PAGE_CSS,
} from '@/components/alumnos/ui';

/** Días transcurridos desde una fecha. Fuera del componente: `Date.now()` en el
 *  cuerpo del render rompe la regla de pureza de React. */
function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

const TABS = [
  { id: 'perfil', label: 'Perfil' },
  { id: 'seguimiento', label: 'Seguimiento' },
  { id: 'proxima', label: 'Próxima clase' },
] as const;
type TabId = typeof TABS[number]['id'];

const DOMAIN_LABEL: Record<string, string> = {
  social: 'Social', laboral: 'Laboral', educacional: 'Educacional',
};

function StudentPageContent() {
  const params = useParams<{ studentId: string }>();
  const routeId = Array.isArray(params.studentId) ? params.studentId[0] : params.studentId;

  const { user } = useAuth();
  const { teachers, assignments, classJoinLogs, loadClassJoinLogs, classRecords } = useTeachers();
  const teacher = teachers.find(t => t.id === user?.teacherId) ?? teachers[0];

  const [bundles, setBundles] = useState<StudentBundle[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabId>('perfil');
  const [toast, setToast] = useState<string | null>(null);
  const [pendingTarget, setPendingTarget] = useState<PendingClass | null>(null);

  const myAssignments = useMemo(
    () => (teacher ? assignments.filter(a => a.teacherId === teacher.id) : []),
    [teacher, assignments],
  );

  const load = useCallback(async () => {
    if (!teacher) return;
    const data = await loadStudentBundles(myAssignments);
    setBundles(data);
    setLoading(false);
  }, [teacher, myAssignments]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!teacher) return;
      const data = await loadStudentBundles(myAssignments);
      if (!cancelled) { setBundles(data); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [teacher, myAssignments]);

  // Los ingresos son la fuente de las clases pendientes de transcript.
  useEffect(() => { loadClassJoinLogs(); }, [loadClassJoinLogs]);

  // Lista alfabética: es la que ordena la navegación anterior/siguiente.
  const ordered = useMemo(
    () => [...bundles].sort((x, y) =>
      x.assignment.studentName.localeCompare(y.assignment.studentName, 'es')),
    [bundles],
  );

  // El alumno de la URL: por student_id, por id de assignment o por nombre.
  const index = useMemo(() => {
    const id = decodeURIComponent(routeId ?? '');
    return ordered.findIndex(b =>
      b.assignment.studentId === id ||
      b.assignment.id === id ||
      norm(b.assignment.studentName) === norm(id.replace(/^name:/, '')),
    );
  }, [ordered, routeId]);

  const bundle = index >= 0 ? ordered[index] : null;
  const prev = index > 0 ? ordered[index - 1] : null;
  const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null;

  function showToast(m: string) {
    setToast(m);
    setTimeout(() => setToast(null), 3200);
  }

  if (loading) {
    return <div className="sp"><div className="sp-empty">Cargando…</div></div>;
  }
  if (!teacher) {
    return <div className="sp"><div className="sp-empty">No se encontró tu ficha de profesor.</div></div>;
  }
  if (!bundle) {
    return (
      <div className="sp">
        <Link href="/mis-alumnos" className="sp-back">← Volver a mis alumnos</Link>
        <div className="sp-empty">No encontramos este alumno entre los tuyos.</div>
      </div>
    );
  }

  const { assignment: a, profile, analyses } = bundle;
  const ficha = fichaFromRow(profile);
  const nextClass = asObject<GeneratedClassIA>(profile?.next_class_content);
  const risk: RiskSignal | null = profile && isRiskSignal(profile.risk_signal) ? profile.risk_signal : null;
  const plan = classCategoryBadge({ assignmentPlan: a.plan, assignmentObjetivo: a.objetivo });
  const lastAnalysis = analyses[0];
  const classNumber = calcRegisteredClassNumber(a, classRecords);
  const nextNumber = lastAnalysis?.class_number != null ? lastAnalysis.class_number + 1 : classNumber;

  const startIso = a.startDate ?? a.createdAt;
  const antiquity = daysSince(startIso);
  const mainSlot = a.slots?.[0] ? `${a.slots[0].day} ${a.slots[0].hour}` : '—';

  const initials = a.studentName.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('');
  const progressScore = profile?.progress_score ?? null;
  // Única fuente por destreza: la autoevaluación del formulario inicial.
  const skills = skillsFromResponses(asObject<Record<string, unknown>>(profile?.form_responses));

  // Clases a las que el profe entró y todavía no tienen transcript.
  const pending = pendingClassesFor({
    studentName: a.studentName, teacherId: teacher.id,
    joinLogs: classJoinLogs, analyses,
  });

  return (
    <>
      {/* ── Navegación entre alumnos ── */}
      <nav className="spnav">
        <div className="spnav-inner">
          <Link href="/mis-alumnos" className="spnav-back" aria-label="Volver a mis alumnos">
            <span aria-hidden>←</span>
            <span className="spnav-back-label">Volver</span>
          </Link>

          <div className="spnav-pager">
            <Link
              href={prev ? hrefFor(prev) : '#'}
              className="spnav-btn"
              aria-disabled={!prev}
              tabIndex={prev ? undefined : -1}
              title={prev?.assignment.studentName}
              aria-label={prev ? `Alumno anterior: ${prev.assignment.studentName}` : 'No hay alumno anterior'}
            >
              <span aria-hidden>←</span>
              <span className="spnav-btn-name">{prev?.assignment.studentName ?? '—'}</span>
            </Link>

            <span className="spnav-count">{index + 1} de {ordered.length}</span>

            <Link
              href={next ? hrefFor(next) : '#'}
              className="spnav-btn"
              aria-disabled={!next}
              tabIndex={next ? undefined : -1}
              title={next?.assignment.studentName}
              aria-label={next ? `Alumno siguiente: ${next.assignment.studentName}` : 'No hay alumno siguiente'}
            >
              <span className="spnav-btn-name">{next?.assignment.studentName ?? '—'}</span>
              <span aria-hidden>→</span>
            </Link>
          </div>
        </div>
      </nav>

      <div className="sp">
        {/* ── Identidad + progreso ── */}
        <div className="sp-card sp-hero" style={{ marginBottom: 18 }}>
          <div className="sp-hero-top">
            <div className="sp-avatar" aria-hidden>{initials || '?'}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <h1 className="sp-name">{a.studentName}</h1>
                {risk && (
                  <span className="sp-chip" style={{ background: RISK_TEXT[risk].color + '1a', borderColor: RISK_TEXT[risk].color + '55', color: RISK_TEXT[risk].color }}>
                    <span className="mcf-dot" style={{ background: RISK_TEXT[risk].color }} />
                    {RISK_TEXT[risk].label}
                  </span>
                )}
              </div>
              <div className="sp-sub" style={{ color: 'var(--sp-t2)' }}>
                {[a.studentLevel, plan.label, teacher.name, startIso ? `Desde ${formatDate(startIso)}` : null]
                  .filter(Boolean).join(' · ')}
              </div>
            </div>
          </div>

          <div className="sp-hero-grid">
            {/* Anillo: progress_score real (1-10). Sin dato → anillo vacío. */}
            <div
              className={`sp-ring${progressScore == null ? ' is-empty' : ''}`}
              style={{ ['--sp-pct' as string]: progressScore != null ? progressScore * 10 : 0 }}
              role="img"
              aria-label={progressScore != null ? `Progreso ${progressScore} de 10` : 'Progreso sin datos'}
            >
              <div className="sp-ring-inner">
                <div>
                  <div className="sp-ring-value">{progressScore != null ? `${progressScore}/10` : '—'}</div>
                  <div className="sp-ring-label">Progreso</div>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
              <div>
                <div className="sp-card-title">Nivel</div>
                <div className="sp-cefr">
                  {cefrSteps(profile?.current_level || a.studentLevel).map(s => (
                    <span
                      key={s.label}
                      className={`sp-cefr-step${s.state === 'done' ? ' is-done' : s.state === 'current' ? ' is-current' : ''}`}
                      aria-current={s.state === 'current' ? 'step' : undefined}
                    >
                      {s.label}
                    </span>
                  ))}
                </div>
              </div>

              <SkillGauges skills={skills} formDate={profile?.form_completed_at ?? null} />
            </div>
          </div>

          {/* ── KPIs ── */}
          <div className="sp-kpis">
            <div className="sp-kpi">
              <div className="sp-kpi-label">Clases</div>
              <div className="sp-kpi-value">{classNumber}</div>
            </div>
            <div className="sp-kpi">
              <div className="sp-kpi-label">Antigüedad</div>
              <div className="sp-kpi-value">{antiquity != null ? `${antiquity} días` : '—'}</div>
            </div>
            <div className="sp-kpi">
              <div className="sp-kpi-label">Horas/sem</div>
              <div className="sp-kpi-value">{a.slots?.length ?? 0}h</div>
            </div>
            <div className="sp-kpi">
              <div className="sp-kpi-label">Próxima</div>
              <div className="sp-kpi-value">{mainSlot}</div>
            </div>
          </div>
        </div>

        <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'perfil' && (
        <PerfilTab
          bundle={bundle} ficha={ficha} risk={risk}
          teacher={{ id: teacher.id, name: teacher.name }}
          onToast={showToast} onRefresh={load}
        />
      )}

      {tab === 'seguimiento' && (
        <SeguimientoTab
          analyses={analyses} risk={risk}
          pending={pending}
          onCompletePending={setPendingTarget}
          progressScore={progressScore}
          classNumber={classNumber}
          skills={skills}
          formDate={profile?.form_completed_at ?? null}
          onGoToProxima={() => setTab('proxima')}
        />
      )}

      {tab === 'proxima' && (
        <ProximaClaseTab
          assignment={a}
          profile={profile}
          ficha={ficha}
          analyses={analyses}
          nextClass={nextClass}
          teacherName={teacher.name}
          nextNumber={nextNumber}
          onToast={showToast}
          onRefresh={load}
          onNextClass={nc => {
            setBundles(prev => prev.map(b => (
              b.assignment.id === a.id && b.profile
                ? { ...b, profile: { ...b.profile, next_class_content: nc } }
                : b
            )));
          }}
        />
      )}

        {pendingTarget && (
          <PendingTranscriptModal
            pending={pendingTarget}
            assignment={a}
            profile={profile}
            ficha={ficha}
            teacher={{ id: teacher.id, name: teacher.name }}
            onClose={() => setPendingTarget(null)}
            onSaved={async () => { await load(); await loadClassJoinLogs(); }}
            onToast={showToast}
          />
        )}

        {toast && <Toast message={toast} />}
      </div>
    </>
  );
}

/**
 * Medidores por destreza. El único dato real es la AUTOEVALUACIÓN del formulario
 * inicial (q6_nivel): se rotula como tal, con su fecha, para no leerla como una
 * evolución. Sin formulario respondido → estado "sin datos", nunca cifras fijas.
 */
function SkillGauges({ skills, formDate }: { skills: SkillGauge[] | null; formDate: string | null }) {
  return (
    <div>
      <div className="sp-card-title">
        Autoevaluación inicial
        {formDate && <span style={{ fontWeight: 400, letterSpacing: 0, textTransform: 'none' }}> · {formatDate(formDate)}</span>}
      </div>

      {skills ? (
        <div className="sp-gauges">
          {skills.map(s => (
            <div key={s.label} className="sp-gauge">
              <span className="sp-gauge-label">{s.label}</span>
              <span
                className="sp-gauge-track"
                role="img"
                aria-label={`${s.label}: ${s.levelLabel}`}
              >
                <span
                  className={`sp-gauge-fill${s.pct <= 40 ? ' is-warn' : ''}`}
                  style={{ width: `${s.pct}%` }}
                />
              </span>
              <span className="sp-gauge-value">{s.levelLabel}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="sp-body" style={{ color: 'var(--sp-t3)', fontSize: 13 }}>
          Sin datos: el alumno todavía no completó el formulario inicial.
        </div>
      )}
    </div>
  );
}

/**
 * Pegar el transcript de una clase PENDIENTE (una a la que el profe ya entró).
 *
 * La fecha NO se teclea: se hereda del ingreso, y el análisis guarda el
 * join_log_id. Así el emparejamiento con finanzas es explícito y no depende de
 * que las fechas coincidan.
 */
function PendingTranscriptModal({ pending, assignment, profile, ficha, teacher, onClose, onSaved, onToast }: {
  pending: PendingClass;
  assignment: Assignment;
  profile: StudentProfileRow | null;
  ficha: FichaIA | null;
  teacher: { id: string; name: string };
  onClose: () => void;
  onSaved: () => Promise<void>;
  onToast: (m: string) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dupe, setDupe] = useState<DupeCheck | null>(null);

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const canSave = words >= 30 && !busy;

  async function persist(hash: string) {
    setBusy(true); setError('');
    try {
      const base = {
        transcript: text.trim(),
        studentName: assignment.studentName,
        teacherName: teacher.name,
        studentId: assignment.studentId || profile?.student_id || null,
        teacherId: teacher.id,
        profileId: profile?.id ?? null,
        plan: assignment.plan,
        level: assignment.studentLevel,
        classDate: pending.date,          // heredada del ingreso
        joinLogId: pending.joinLogId,     // vínculo explícito
        transcriptHash: hash || null,
        studentProfile: ficha,
      };
      const analysis = await analyzeTranscriptOnly(base);
      await saveAnalysis({ ...base, analysis });
      await onSaved();
      onToast('Clase completada');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar el transcript.');
      setBusy(false);
    }
  }

  async function handleSave() {
    if (!canSave) return;
    const hash = transcriptHash(text);
    setBusy(true);
    let res: DupeCheck;
    try {
      res = await checkTranscriptDuplicates({
        teacherId: teacher.id, studentName: assignment.studentName, classDate: pending.date, hash,
      });
    } catch {
      res = { kind: 'none' };
    } finally {
      setBusy(false);
    }
    if (res.kind === 'none') { await persist(hash); return; }
    setDupe(res);
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="sp" style={{ background: '#fff', borderRadius: 16, padding: 24, maxWidth: 560, width: '100%', margin: 0, maxHeight: '88vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>
          Completar clase del {formatDate(pending.date)}
        </div>
        <div style={{ fontSize: 13, color: 'var(--sp-t2)', marginBottom: 16 }}>
          {assignment.studentName}{pending.time ? ` · ${pending.time}` : ''} · Pegá el transcript de Fathom.
        </div>

        <textarea
          value={text}
          onChange={e => { setText(e.target.value); setError(''); }}
          rows={9}
          placeholder="Pegá acá el texto que genera Fathom al terminar la sesión..."
          style={{ width: '100%', boxSizing: 'border-box', borderRadius: 10, border: '1px solid var(--border)', padding: '11px 13px', fontFamily: 'inherit', fontSize: 14, lineHeight: 1.5, resize: 'vertical' }}
        />
        <div style={{ fontSize: 12, color: words >= 30 ? '#1E9E3A' : 'var(--sp-t3)', marginTop: 6 }}>
          {words} palabras{words < 30 ? ' · mínimo 30' : ''}
        </div>

        {error && (
          <div style={{ marginTop: 12, padding: '10px 13px', borderRadius: 9, background: 'rgba(220,38,38,0.07)', color: '#B91C1C', fontSize: 13, lineHeight: 1.5 }}>{error}</div>
        )}

        <div className="sp-btn-row" style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button onClick={onClose} disabled={busy} style={{ ...btnSecondary, flex: 1 }}>Cancelar</button>
          <button onClick={handleSave} disabled={!canSave} style={{ ...btnPrimary, flex: 2, opacity: canSave ? 1 : 0.6 }}>
            {busy ? 'Analizando…' : 'Guardar y generar siguiente'}
          </button>
        </div>

        {dupe && dupe.kind !== 'none' && (
          <div style={{ marginTop: 16, padding: '13px 15px', borderRadius: 10, background: '#fdf3e7', border: '1px solid #f2e2c9' }}>
            <div style={{ fontSize: 13.5, color: '#9a6516', lineHeight: 1.6, marginBottom: 10 }}>
              {dupe.kind === 'blocked'
                ? 'Este mismo texto ya está registrado para esta clase.'
                : dupe.kind === 'other-class'
                  ? `Este transcript parece el mismo que subiste para ${dupe.row.student_name}. ¿Seguro que es el correcto?`
                  : 'Ya hay un transcript para esta clase. Se reemplazará por el nuevo.'}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setDupe(null)} style={{ ...btnSecondary, flex: 1 }}>
                {dupe.kind === 'blocked' ? 'Cerrar' : 'Cancelar'}
              </button>
              {dupe.kind !== 'blocked' && (
                <button onClick={() => { const d = dupe; setDupe(null); persist(transcriptHash(text)); void d; }} style={{ ...btnPrimary, flex: 1 }}>
                  Continuar
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** URL de la ficha de un alumno (mismo criterio que StudentCard). */
function hrefFor(b: StudentBundle): string {
  return `/mis-alumnos/${encodeURIComponent(b.assignment.studentId || b.assignment.id)}`;
}

// ═══ TAB PERFIL ═══════════════════════════════════════════════════════════════
function PerfilTab({ bundle, ficha, risk, teacher, onToast, onRefresh }: {
  bundle: StudentBundle;
  ficha: FichaIA | null;
  risk: RiskSignal | null;
  teacher: { id: string; name: string };
  onToast: (m: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const { assignment: a, profile, analyses } = bundle;
  const [busy, setBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const last = analyses[0];

  const responses = asObject<Record<string, unknown>>(profile?.form_responses) ?? {};
  const hasResponses = Object.keys(responses).length > 0;

  // Reutiliza el link vigente del formulario del alumno (o crea uno) con el
  // mismo helper que usa el email de presentación: no inventa un flujo nuevo.
  async function handleCopyFormLink() {
    setBusy(true);
    try {
      const url = await getOrCreateFormLink({
        studentId: a.studentId || undefined,
        studentName: a.studentName,
        studentEmail: a.studentEmail || undefined,
        teacherId: teacher.id,
        teacherName: teacher.name,
        assignmentId: a.id,
        plan: a.plan || undefined,
        level: a.studentLevel || undefined,
      });
      await navigator.clipboard.writeText(url);
      onToast('Link del formulario copiado');
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'No se pudo generar el link.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRegenerate() {
    if (!profile) return;
    setBusy(true);
    try {
      await regenerateFicha({ profileId: profile.id, teacherName: teacher.name, plan: a.plan, level: a.studentLevel });
      await onRefresh();
      onToast('Ficha generada correctamente');
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'No se pudo generar la ficha.');
    } finally {
      setBusy(false);
    }
  }

  if (!ficha) {
    return (
      <div className="sp-card sp-empty">
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--sp-t1)', marginBottom: 6 }}>Sin ficha de IA</div>
        <div style={{ maxWidth: 380, margin: '0 auto 18px', lineHeight: 1.6 }}>
          Envía el formulario inicial al alumno para generar su perfil automáticamente.
        </div>
        <div className="sp-btn-row" style={{ display: 'inline-flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button onClick={handleCopyFormLink} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Generando…' : 'Copiar link del formulario'}
          </button>
          {/* Si ya hay respuestas guardadas, la ficha se puede generar sin esperar. */}
          {profile && (
            <button onClick={handleRegenerate} disabled={busy} style={btnSecondary}>Generar ficha ahora</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="sp-cols">
        {/* ── Columna izquierda ── */}
        <div className="sp-col">
          <div className="sp-card sp-objective">
            <div className="sp-card-title">Objetivo</div>
            <div className="sp-body">{ficha.personalObjective || 'Sin objetivo registrado.'}</div>
          </div>

          <div className="sp-card">
            <div className="sp-card-title">Perfil</div>
            <Field label="Ocupación" value={ficha.occupation} />
            <Field label="Estilo de aprendizaje" value={ficha.learningStyle} />
            <Field label="Dominio" value={DOMAIN_LABEL[ficha.domain] ?? ficha.domain} />
            <Field label="Nivel actual" value={profile?.current_level || a.studentLevel} />
          </div>

          {last && (
            <div className="sp-card">
              <div className="sp-card-title">Estado actual</div>
              <Field label="Foco de la última clase" value={last.topics_covered || '—'} />
              <Field label="Última clase analizada" value={relativeDays(last.class_date ?? last.analyzed_at)} />
              {risk && <RiskDot risk={risk} size={10} />}
            </div>
          )}

          <button onClick={() => setShareOpen(true)} style={{ ...btnSecondary, width: '100%' }}>
            Compartir progreso con el alumno
          </button>
        </div>

        {/* ── Columna derecha ── */}
        <div className="sp-col">
          {ficha.strongPoints && (
            <div className="sp-card">
              <div className="sp-card-title">Puntos fuertes</div>
              <BulletList items={toBullets(ficha.strongPoints)} variant="ok" />
            </div>
          )}

          {ficha.weakPoints && (
            <div className="sp-card">
              <div className="sp-card-title">Áreas a trabajar</div>
              <BulletList items={toBullets(ficha.weakPoints)} variant="warn" />
            </div>
          )}
        </div>
      </div>

      {/* ── Ancho completo ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16 }}>
        {ficha.recommendedFocus && (
          <div className="sp-card sp-amber">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
              <span className="sp-card-title" style={{ marginBottom: 0 }}>Foco actual</span>
              <span className="sp-badge-yellow">Prioridad</span>
            </div>
            <div className="sp-body">{ficha.recommendedFocus}</div>
          </div>
        )}

        {(ficha.initialDiagnosis || hasResponses) && (
          <div className="sp-card" style={{ paddingTop: 8, paddingBottom: 8 }}>
            {ficha.initialDiagnosis && (
              <Accordion title="Ver diagnóstico completo">
                <div className="sp-body">{ficha.initialDiagnosis}</div>
              </Accordion>
            )}
            {hasResponses && (
              <Accordion title="Respuestas del formulario">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {FORM_QUESTIONS.map(q => {
                    const v = responses[q.id];
                    let text: string;
                    if (q.type === 'checkbox' && Array.isArray(v)) text = v.length ? (v as string[]).join(', ') : '—';
                    else if (q.type === 'matrix' && v && typeof v === 'object') {
                      const obj = v as Record<string, string>;
                      text = (q.rows ?? []).map(r => `${r}: ${obj[r] ?? '—'}`).join(' · ');
                    } else text = v != null && String(v).trim() ? String(v) : '—';
                    return (
                      <div key={q.id}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>{q.title}</div>
                        <div className="sp-body" style={{ color: 'var(--sp-t2)' }}>{text}</div>
                      </div>
                    );
                  })}
                </div>
              </Accordion>
            )}
          </div>
        )}
      </div>

      {shareOpen && (
        <ShareModal
          studentName={a.studentName}
          studentId={a.studentId}
          teacherId={teacher.id}
          onClose={() => setShareOpen(false)}
          onToast={onToast}
        />
      )}
    </>
  );
}

function Field({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="sp-card-title" style={{ marginBottom: 4 }}>{label}</div>
      <div className="sp-body">{value}</div>
    </div>
  );
}

// ═══ TAB SEGUIMIENTO ══════════════════════════════════════════════════════════
function SeguimientoTab({ analyses, risk, progressScore, classNumber, skills, formDate, pending, onCompletePending, onGoToProxima }: {
  analyses: ClassAnalysisRow[];
  risk: RiskSignal | null;
  pending: PendingClass[];
  onCompletePending: (p: PendingClass) => void;
  progressScore: number | null;
  classNumber: number;
  skills: SkillGauge[] | null;
  formDate: string | null;
  onGoToProxima: () => void;
}) {
  const milestone = milestoneProgress(classNumber);

  if (analyses.length === 0 && pending.length === 0) {
    return (
      <div className="sp-card sp-empty">
        <div style={{ marginBottom: 16 }}>
          Aún no hay clases registradas. Registra la primera clase después de darla.
        </div>
        <button onClick={onGoToProxima} style={btnPrimary}>Registrar primera clase</button>
      </div>
    );
  }

  const last = analyses[0];

  return (
    <>
      {pending.length > 0 && (
        <div className="sp-card sp-amber" style={{ marginBottom: 16 }}>
          <div className="sp-card-title">
            Clases pendientes de transcript · {pending.length}
          </div>
          <div style={{ fontSize: 13, color: 'var(--sp-t2)', lineHeight: 1.6, marginBottom: 12 }}>
            Entraste a estas clases pero todavía no subiste el transcript. Hasta que lo
            hagas quedan como “a revisar” en finanzas.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pending.map(p => (
              <div key={p.joinLogId} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', borderTop: '1px solid #f2e2c9', paddingTop: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#e0912f', flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600 }}>
                  {formatDate(p.date)}{p.time ? ` · ${p.time}` : ''}
                </span>
                <button onClick={() => onCompletePending(p)} style={{ ...btnPrimary, padding: '7px 14px', fontSize: 12.5 }}>
                  Pegar transcript
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {analyses.length > 0 && (
      <div className="sp-metrics" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="sp-card">
          <div className="sp-metric">{analyses.length}</div>
          <div className="sp-metric-label">Clases analizadas</div>
        </div>
        <div className="sp-card">
          <div className="sp-metric" style={{ fontSize: 20 }}>
            {relativeDays(last.class_date ?? last.analyzed_at)}
          </div>
          <div className="sp-metric-label">Última clase</div>
        </div>
        <div className="sp-card">
          <div style={{ paddingTop: 4 }}>
            {risk ? <RiskDot risk={risk} size={10} /> : <span className="sp-body">—</span>}
          </div>
          <div className="sp-metric-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            Señal actual{progressScore != null ? ` · progreso ${progressScore}/10` : ''}
            <HelpTooltip tooltipKey="alumnos.riesgo" />
          </div>
        </div>
      </div>
      )}

      {/* Trayectoria hacia el próximo hito REAL (1 · 15 · 30 · 50). */}
      {milestone && (
        <div className="sp-card" style={{ marginBottom: 16 }}>
          <div className="sp-card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            Trayectoria · clase {milestone.current} de {milestone.target}
            <HelpTooltip tooltipKey="alumnos.trayectoria" />
          </div>
          <div className="sp-nodes" role="img"
            aria-label={`${milestone.current} de ${milestone.target} clases hacia el próximo hito`}>
            {Array.from({ length: milestone.target }, (_, i) => {
              const n = i + 1;
              const done = n <= milestone.current;
              const current = n === milestone.current;
              return (
                <Fragment key={n}>
                  {i > 0 && <span className={`sp-node-link${done ? ' is-done' : ''}`} />}
                  <span
                    className={`sp-node${done ? ' is-done' : ''}${current ? ' is-current' : ''}`}
                    title={`Clase ${n}`}
                  >
                    {done ? '✓' : ''}
                  </span>
                </Fragment>
              );
            })}
          </div>
          <div className="sp-body" style={{ fontSize: 12.5, color: 'var(--sp-t3)' }}>
            Próximo hito: clase {milestone.target}
          </div>
        </div>
      )}

      <div className="sp-card" style={{ marginBottom: 16 }}>
        <SkillGauges skills={skills} formDate={formDate} />
      </div>

      <div className="sp-timeline">
        {analyses.map(r => {
          const rowRisk: RiskSignal | null = isRiskSignal(r.risk_signal) ? r.risk_signal : null;
          const guide = asObject<NextClassGuide>(r.next_class_guide);
          return (
            <div key={r.id} className="sp-tl-item">
              <span
                className="sp-tl-node"
                aria-hidden
                style={rowRisk ? { borderColor: RISK_TEXT[rowRisk].color } : undefined}
              />
              <div className="sp-card">
              <div className="sp-feed-head">
                <div className="sp-feed-title">
                  Clase {r.class_number ?? '—'}
                  <span className="sp-feed-date"> · {formatDate(r.class_date ?? r.analyzed_at)}</span>
                </div>
                {rowRisk && <RiskDot risk={rowRisk} showLabel={false} size={8} />}
              </div>

              {r.class_title && (
                <div style={{ fontSize: 13.5, color: 'var(--sp-t2)', marginTop: 4 }}>{r.class_title}</div>
              )}

              {r.class_summary && (
                <div style={{ marginTop: 12 }}>
                  <div className="sp-card-title">Resumen</div>
                  <ClampText text={r.class_summary} />
                </div>
              )}

              <div style={{ marginTop: 12 }}>
                {r.errors_detected && (
                  <Accordion title="Errores detectados">
                    <BulletList items={toBullets(r.errors_detected)} variant="error" />
                  </Accordion>
                )}
                {r.progress_notes && (
                  <Accordion title="Progreso">
                    <ProgressCompare text={r.progress_notes} />
                  </Accordion>
                )}
                {guide && (
                  <Accordion title="Guía siguiente clase">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {(['priority', 'warmUp', 'mainFocus', 'activity', 'notes'] as const).map(k => (
                        guide[k] ? (
                          <div key={k}>
                            <div className="sp-card-title" style={{ marginBottom: 4 }}>{GUIDE_LABELS[k]}</div>
                            <div className="sp-body">{guide[k]}</div>
                          </div>
                        ) : null
                      ))}
                    </div>
                  </Accordion>
                )}
              </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

const GUIDE_LABELS: Record<string, string> = {
  priority: 'Prioridad', warmUp: 'Warm-up', mainFocus: 'Foco principal',
  activity: 'Actividad', notes: 'Notas',
};

// ═══ MODAL COMPARTIR ══════════════════════════════════════════════════════════
function ShareModal({ studentName, studentId, teacherId, onClose, onToast }: {
  studentName: string;
  studentId?: string | null;
  teacherId: string;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const link = await getProgressLink({ studentId, studentName, teacherId });
        if (!cancelled) setUrl(link);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'No se pudo generar el link.');
      }
    })();
    return () => { cancelled = true; };
  }, [studentId, studentName, teacherId]);

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      onToast('Link copiado');
    } catch {
      onToast('No se pudo copiar automáticamente.');
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="sp" style={{ background: '#fff', borderRadius: 14, padding: 24, maxWidth: 460, width: '100%', margin: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>Compartir progreso</div>
        <div style={{ fontSize: 13.5, color: 'var(--sp-t2)', lineHeight: 1.6, marginBottom: 16 }}>
          Este link permite a {studentName} ver su propio progreso. Es de solo lectura y expira en 30 días.
        </div>

        {error ? (
          <div style={{ fontSize: 13, color: '#B91C1C', lineHeight: 1.5 }}>{error}</div>
        ) : !url ? (
          <div style={{ fontSize: 13.5, color: 'var(--sp-t3)' }}>Generando link…</div>
        ) : (
          <>
            <div className="sp-linkbox">{url}</div>
            <div className="sp-btn-row" style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button onClick={copy} style={btnPrimary}>Copiar link</button>
              <a href={url} target="_blank" rel="noopener noreferrer" style={{ ...btnSecondary, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
                Abrir en nueva pestaña
              </a>
            </div>
          </>
        )}

        <button onClick={onClose} style={{ ...btnSecondary, width: '100%', marginTop: 10 }}>Cerrar</button>
      </div>
    </div>
  );
}

export default function StudentPage() {
  return (
    <AuthGuard allowedRoles={['teacher']}>
      <div style={{ minHeight: '100vh', background: '#F7F7F5' }}>
        <style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} />
        <NavBar />
        <StudentPageContent />
      </div>
    </AuthGuard>
  );
}
