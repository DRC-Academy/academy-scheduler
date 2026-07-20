'use client';

// Página completa del alumno. Sustituye al popup de "Ver ficha" y a las tabs
// que StudentCard mostraba en línea dentro de la lista.
//
// El identificador de la URL puede ser el student_id real o, si el alumno no lo
// tiene, el id de la assignment: se resuelve contra las dos cosas.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { calcCurrentClassNumber } from '@/lib/db';
import { loadStudentBundles, norm, type StudentBundle } from '@/lib/misAlumnos';
import { regenerateFicha } from '@/lib/aiClient';
import { getProgressLink } from '@/lib/progressClient';
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
  Avatar, RiskDot, Tabs, Toast, btnPrimary, btnSecondary, formatDate, relativeDays,
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
  const { teachers, assignments } = useTeachers();
  const teacher = teachers.find(t => t.id === user?.teacherId) ?? teachers[0];

  const [bundles, setBundles] = useState<StudentBundle[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabId>('perfil');
  const [toast, setToast] = useState<string | null>(null);

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

  // El alumno de la URL: por student_id, por id de assignment o por nombre.
  const bundle = useMemo(() => {
    const id = decodeURIComponent(routeId ?? '');
    return bundles.find(b =>
      b.assignment.studentId === id ||
      b.assignment.id === id ||
      norm(b.assignment.studentName) === norm(id.replace(/^name:/, '')),
    ) ?? null;
  }, [bundles, routeId]);

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
  const classNumber = calcCurrentClassNumber(a);
  const nextNumber = lastAnalysis?.class_number != null ? lastAnalysis.class_number + 1 : classNumber;

  const startIso = a.startDate ?? a.createdAt;
  const antiquity = daysSince(startIso);
  const mainSlot = a.slots?.[0] ? `${a.slots[0].day} ${a.slots[0].hour}` : '—';

  return (
    <div className="sp">
      {/* ── Cabecera ── */}
      <Link href="/mis-alumnos" className="sp-back">← Volver a mis alumnos</Link>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 8 }}>
        <Avatar name={a.studentName} />
        <div style={{ minWidth: 0 }}>
          <h1 className="sp-name">{a.studentName}</h1>
          <div className="sp-sub">
            <span>{[a.studentLevel, plan.label].filter(Boolean).join(' · ')}</span>
            {risk && <RiskDot risk={risk} size={10} />}
          </div>
        </div>
      </div>

      {/* ── Datos rápidos ── */}
      <div className="sp-quick">
        <div>
          <div className="sp-quick-label">Inicio</div>
          <div className="sp-quick-value">{startIso ? formatDate(startIso) : '—'}</div>
        </div>
        <div>
          <div className="sp-quick-label">Antigüedad</div>
          <div className="sp-quick-value">{antiquity != null ? `${antiquity} días` : '—'}</div>
        </div>
        <div>
          <div className="sp-quick-label">Clases</div>
          <div className="sp-quick-value">{classNumber}</div>
        </div>
        <div>
          <div className="sp-quick-label">Horas/sem</div>
          <div className="sp-quick-value">{a.slots?.length ?? 0}</div>
        </div>
        <div>
          <div className="sp-quick-label">Próxima</div>
          <div className="sp-quick-value">{mainSlot}</div>
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
          progressScore={profile?.progress_score ?? null}
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

      {toast && <Toast message={toast} />}
    </div>
  );
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
        <div style={{ marginBottom: 14 }}>Este alumno todavía no tiene ficha generada.</div>
        {profile
          ? <button onClick={handleRegenerate} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Generando…' : 'Generar ficha'}
            </button>
          : <div style={{ fontSize: 13 }}>Falta que el alumno complete el formulario inicial.</div>}
      </div>
    );
  }

  return (
    <>
      <div className="sp-cols">
        {/* ── Columna izquierda (40%) ── */}
        <div className="sp-col">
          <div className="sp-card sp-objective">
            <div className="sp-card-title">Objetivo</div>
            <div className="sp-body">{ficha.personalObjective || 'Sin objetivo registrado.'}</div>
          </div>

          <div className="sp-card">
            <div className="sp-card-title">Perfil</div>
            <Field label="Ocupación" value={ficha.occupation} />
            <Field label="Dominio" value={DOMAIN_LABEL[ficha.domain] ?? ficha.domain} />
            <Field label="Nivel actual" value={profile?.current_level || a.studentLevel} />
          </div>

          {ficha.learningStyle && (
            <div className="sp-card">
              <div className="sp-card-title">Estilo de aprendizaje</div>
              <div className="sp-body">{ficha.learningStyle}</div>
            </div>
          )}

          <button onClick={() => setShareOpen(true)} style={{ ...btnSecondary, width: '100%' }}>
            Compartir progreso con el alumno
          </button>
        </div>

        {/* ── Columna derecha (60%) ── */}
        <div className="sp-col">
          <div className="sp-card">
            <div className="sp-card-title">Estado actual</div>
            {last ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Field label="Foco actual" value={last.topics_covered || '—'} />
                <div>
                  <div className="sp-card-title" style={{ marginBottom: 6 }}>Señal</div>
                  {risk ? <RiskDot risk={risk} size={10} /> : <span className="sp-body">Sin señal registrada</span>}
                </div>
                <Field
                  label="Última clase analizada"
                  value={relativeDays(last.class_date ?? last.analyzed_at)}
                />
              </div>
            ) : (
              <div className="sp-body" style={{ color: 'var(--sp-t3)' }}>Sin clases analizadas todavía.</div>
            )}
          </div>

          {ficha.strongPoints && (
            <div className="sp-card">
              <div className="sp-card-title">Puntos fuertes</div>
              <BulletList items={toBullets(ficha.strongPoints)} />
            </div>
          )}

          {ficha.weakPoints && (
            <div className="sp-card">
              <div className="sp-card-title">Áreas a trabajar</div>
              <BulletList items={toBullets(ficha.weakPoints)} />
            </div>
          )}

          {ficha.recommendedFocus && (
            <div className="sp-card">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
                <span className="sp-card-title" style={{ marginBottom: 0 }}>Foco recomendado</span>
                <span className="sp-badge-yellow">Prioridad actual</span>
              </div>
              <div className="sp-body">{ficha.recommendedFocus}</div>
            </div>
          )}

          {ficha.initialDiagnosis && (
            <div className="sp-card" style={{ paddingTop: 8, paddingBottom: 8 }}>
              <Accordion title="Diagnóstico inicial">
                <div className="sp-body">{ficha.initialDiagnosis}</div>
              </Accordion>
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
function SeguimientoTab({ analyses, risk, progressScore, onGoToProxima }: {
  analyses: ClassAnalysisRow[];
  risk: RiskSignal | null;
  progressScore: number | null;
  onGoToProxima: () => void;
}) {
  if (analyses.length === 0) {
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
      <div className="sp-metrics">
        <div className="sp-card">
          <div className="sp-metric">{analyses.length}</div>
          <div className="sp-metric-label">Clases analizadas</div>
        </div>
        <div className="sp-card">
          <div className="sp-metric">{progressScore != null ? `${progressScore}/10` : '—'}</div>
          <div className="sp-metric-label">Progreso</div>
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
          <div className="sp-metric-label">Señal actual</div>
        </div>
      </div>

      <div className="sp-feed">
        {analyses.map(r => {
          const rowRisk: RiskSignal | null = isRiskSignal(r.risk_signal) ? r.risk_signal : null;
          const guide = asObject<NextClassGuide>(r.next_class_guide);
          return (
            <div key={r.id} className="sp-card">
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
