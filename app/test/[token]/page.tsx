'use client';

// Página PÚBLICA del Test de Nivel (link único, sin login). Estado 100% en
// Supabase vía la API (nada en localStorage): recargar retoma donde quedó.
// Flujo: Welcome → Reading (completion/passage/email, adaptativo) → Writing →
// Resultados. Diseño standalone con branding DRC (verde, Radio Canada).

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import type { LTQuestionPublic, LTProgress, WritingEvaluation, Cefr } from '@/lib/levelTest/types';
import { SECTION_LABEL, CEFR_DESC, CEFR_COLOR } from '@/lib/levelTest/constants';

const GREEN = '#1E9E3A';
const GREEN_DARK = '#167a2d';

interface Result {
  reading_score: number | null;
  writing_score: number | null;
  overall_score: number | null;
  cefr_level: Cefr | null;
  ai_evaluation: WritingEvaluation | null;
}
type Phase = 'loading' | 'invalid' | 'expired' | 'welcome' | 'testing' | 'results';

export default function TestPage() {
  const params = useParams<{ token: string }>();
  const token = Array.isArray(params.token) ? params.token[0] : params.token;

  const [phase, setPhase] = useState<Phase>('loading');
  const [candidateName, setCandidateName] = useState('');
  const [resuming, setResuming] = useState(false);

  const [question, setQuestion] = useState<LTQuestionPublic | null>(null);
  const [progress, setProgress] = useState<LTProgress | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const [selected, setSelected] = useState<number | null>(null);
  const [written, setWritten] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Carga inicial: lee la sesión SIN iniciar el test (como la página del form).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) { setPhase('invalid'); return; }
      const { data, error: e } = await supabase
        .from('level_test_sessions')
        .select('candidate_name, student_name, status, expires_at, reading_score, writing_score, overall_score, cefr_level, ai_evaluation')
        .eq('token', token).maybeSingle();
      if (cancelled) return;
      if (e || !data) { setPhase('invalid'); return; }
      setCandidateName(data.student_name || data.candidate_name || '');
      if (data.status === 'completed') {
        setResult({
          reading_score: data.reading_score, writing_score: data.writing_score,
          overall_score: data.overall_score, cefr_level: data.cefr_level as Cefr | null,
          ai_evaluation: data.ai_evaluation as WritingEvaluation | null,
        });
        setPhase('results');
        return;
      }
      const expired = data.expires_at && new Date(data.expires_at).getTime() < Date.now();
      if (data.status === 'expired' || expired) { setPhase('expired'); return; }
      setResuming(data.status === 'in_progress');
      setPhase('welcome');
    })();
    return () => { cancelled = true; };
  }, [token]);

  async function loadCurrent() {
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/level-test/${token}`, { cache: 'no-store' });
      const data = await res.json();
      if (data.status === 'completed') { setResult(data.result); setPhase('results'); return; }
      if (data.status === 'expired') { setPhase('expired'); return; }
      if (!res.ok || data.status === 'invalid') { setPhase('invalid'); return; }
      if (data.done || !data.question) { await finalize(); return; }
      setQuestion(data.question); setProgress(data.progress);
      setSelected(null); setWritten('');
      setPhase('testing');
    } catch { setError('No se pudo cargar el test. Revisá tu conexión.'); }
    finally { setBusy(false); }
  }

  async function finalize() {
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/level-test/${token}/submit`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { setError(data?.error || 'No se pudo finalizar el test.'); return; }
      setResult(data); setPhase('results');
    } catch { setError('No se pudo finalizar el test.'); }
    finally { setBusy(false); }
  }

  async function submitAnswer() {
    if (!question || busy) return;
    const isWriting = question.section === 'writing';
    if (!isWriting && selected == null) return;
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/level-test/${token}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question_id: question.id,
          selected_answer: isWriting ? undefined : selected,
          written_response: isWriting ? written : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error || 'No se pudo guardar la respuesta.'); return; }
      if (data.done || !data.question) { await finalize(); return; }
      setQuestion(data.question); setProgress(data.progress);
      setSelected(null); setWritten('');
    } catch { setError('No se pudo guardar la respuesta.'); }
    finally { setBusy(false); }
  }

  // ── Render por fase ──────────────────────────────────────────────────────────
  if (phase === 'loading') return <Shell><Centered>Cargando…</Centered></Shell>;
  if (phase === 'invalid') return <Shell><Centered>Este link no es válido o ya no está disponible.</Centered></Shell>;
  if (phase === 'expired') return <Shell><Centered>Este link ya expiró. Pedí uno nuevo a tu asesor de DRC Academy.</Centered></Shell>;

  if (phase === 'welcome') {
    return (
      <Shell>
        <Card>
          <Brand />
          <h1 style={{ fontSize: 24, fontWeight: 600, color: '#11241a', margin: '18px 0 6px', letterSpacing: '-0.015em' }}>
            {resuming ? `¡Seguimos, ${firstName(candidateName)}!` : `¡Hola${candidateName ? `, ${firstName(candidateName)}` : ''}!`}
          </h1>
          <p style={{ fontSize: 14, color: '#5c6a61', margin: '0 0 16px', lineHeight: 1.6 }}>
            Este test evalúa tu nivel de inglés en <b>Reading</b> y <b>Writing</b>.
          </p>
          <ul style={{ fontSize: 13.5, color: '#5c6a61', lineHeight: 1.9, margin: '0 0 20px', paddingLeft: 18 }}>
            <li>Duración aproximada: <b>20–30 minutos</b>.</li>
            <li>3 secciones de Reading (completar oraciones, textos y emails) y 1 de Writing.</li>
            <li>Una vez iniciado, no podrás volver a preguntas anteriores.</li>
            <li>Al finalizar verás tu resultado y tu nivel CEFR.</li>
          </ul>
          {error && <ErrorLine>{error}</ErrorLine>}
          <PrimaryButton onClick={loadCurrent} disabled={busy}>
            {busy ? 'Cargando…' : resuming ? 'Continuar test' : 'Empezar el test'}
          </PrimaryButton>
        </Card>
      </Shell>
    );
  }

  if (phase === 'results' && result) {
    return <Shell><ResultsScreen result={result} name={candidateName} /></Shell>;
  }

  // testing
  if (phase === 'testing' && question && progress) {
    const isWriting = question.section === 'writing';
    return (
      <Shell>
        <div style={{ width: '100%', maxWidth: 720 }}>
          <ProgressBar progress={progress} />
          <Card>
            <div style={{ fontSize: 11, fontWeight: 600, color: GREEN_DARK, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
              {SECTION_LABEL[question.section]}
            </div>

            {question.prompt_text && (
              <div style={{ background: '#f5f7f4', border: '1px solid #eef1ee', borderRadius: 10, padding: '14px 16px', marginBottom: 16, fontSize: 14, color: '#11241a', lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
                {question.prompt_text}
              </div>
            )}

            {isWriting ? (
              <WritingSection
                prompt={question.writing_prompt || ''}
                minWords={question.writing_min_words || 50}
                value={written}
                onChange={setWritten}
                busy={busy}
              />
            ) : (
              <>
                <div style={{ fontSize: 16, fontWeight: 600, color: '#11241a', margin: '0 0 16px', lineHeight: 1.5 }}>
                  {question.question_text}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {(question.options || []).map((opt, i) => {
                    const active = selected === i;
                    return (
                      <button key={i} onClick={() => setSelected(i)}
                        style={{
                          textAlign: 'left', padding: '13px 15px', borderRadius: 10, cursor: 'pointer',
                          fontFamily: 'inherit', fontSize: 14.5, lineHeight: 1.4,
                          border: `1.5px solid ${active ? GREEN : '#e3e7e0'}`,
                          background: active ? 'rgba(30,158,58,0.08)' : '#fff',
                          color: active ? GREEN_DARK : '#11241a',
                          fontWeight: active ? 600 : 400,
                        }}>
                        {opt}
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {error && <ErrorLine>{error}</ErrorLine>}

            <div style={{ marginTop: 22 }}>
              <PrimaryButton
                onClick={submitAnswer}
                disabled={busy || (isWriting ? countWords(written) < (question.writing_min_words || 50) : selected == null)}
              >
                {busy ? (isWriting ? 'Evaluando…' : 'Guardando…') : 'Siguiente'}
              </PrimaryButton>
            </div>
          </Card>
        </div>
      </Shell>
    );
  }

  return <Shell><Centered>Cargando…</Centered></Shell>;
}

// ── Sub-componentes ──────────────────────────────────────────────────────────
function firstName(name: string): string { return (name || '').trim().split(/\s+/)[0] || ''; }
function countWords(s: string): number { const t = s.trim(); return t ? t.split(/\s+/).length : 0; }

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: '#f5f7f4', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px 16px' }}>
      {children}
    </div>
  );
}
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ width: '100%', maxWidth: 720, background: '#fff', border: '1px solid #eef1ee', borderRadius: 16, padding: '28px 26px', boxShadow: '0 8px 24px rgba(0,0,0,0.06)' }}>
      {children}
    </div>
  );
}
function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ maxWidth: 460, textAlign: 'center', color: '#5c6a61', fontSize: 15, lineHeight: 1.7 }}>{children}</div>;
}
function Brand() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/drc-logo.png" alt="DRC Academy" style={{ height: 34, width: 'auto', display: 'block' }} />
  );
}
function ErrorLine({ children }: { children: React.ReactNode }) {
  return <div style={{ marginTop: 14, fontSize: 13, color: '#b42318' }}>{children}</div>;
}
function PrimaryButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        width: '100%', minHeight: 48, padding: '13px', borderRadius: 10, border: 'none',
        background: disabled ? '#c8d3cb' : GREEN, color: '#fff', cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 15, fontWeight: 600, fontFamily: 'inherit',
      }}>
      {children}
    </button>
  );
}

function ProgressBar({ progress }: { progress: LTProgress }) {
  const pct = Math.round((progress.answeredTotal / progress.grandTotal) * 100);
  return (
    <div style={{ width: '100%', maxWidth: 720, margin: '0 auto 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#5c6a61', marginBottom: 6 }}>
        <span>Sección {progress.sectionIndex + 1} de {progress.sectionTotal} · {SECTION_LABEL[progress.section]}</span>
        <span>{progress.answeredTotal} / {progress.grandTotal}</span>
      </div>
      <div style={{ height: 8, borderRadius: 999, background: '#e3e7e0', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: GREEN, borderRadius: 999, transition: 'width 0.3s ease' }} />
      </div>
    </div>
  );
}

function WritingSection({ prompt, minWords, value, onChange, busy }: {
  prompt: string; minWords: number; value: string; onChange: (v: string) => void; busy: boolean;
}) {
  const words = countWords(value);
  const ok = words >= minWords;
  return (
    <>
      <div style={{ fontSize: 15.5, fontWeight: 600, color: '#11241a', margin: '0 0 6px', lineHeight: 1.5 }}>{prompt}</div>
      <div style={{ fontSize: 12.5, color: '#98a49b', marginBottom: 12 }}>Mínimo {minWords} palabras.</div>
      <textarea
        value={value} onChange={e => onChange(e.target.value)} disabled={busy} rows={10}
        placeholder="Write your answer here…"
        style={{ width: '100%', padding: '13px 15px', borderRadius: 10, border: '1.5px solid #e3e7e0', background: '#fff', color: '#11241a', fontSize: 14.5, fontFamily: 'inherit', lineHeight: 1.6, resize: 'vertical', boxSizing: 'border-box' }}
      />
      <div style={{ fontSize: 12.5, color: ok ? GREEN_DARK : '#98a49b', marginTop: 6 }}>
        {words} palabra{words === 1 ? '' : 's'}{ok ? ' ✓' : ` · faltan ${minWords - words}`}
      </div>
    </>
  );
}

function ResultsScreen({ result, name }: { result: Result; name: string }) {
  const cefr = (result.cefr_level || 'A1') as Cefr;
  const color = CEFR_COLOR[cefr] || GREEN;
  const overall = Math.round(result.overall_score ?? 0);
  const ev = result.ai_evaluation;
  return (
    <Card>
      <Brand />
      <div style={{ textAlign: 'center', margin: '18px 0 8px' }}>
        <ScoreGauge value={overall} color={color} />
        <div style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, color: '#5c6a61' }}>Nivel</span>
          <span style={{ fontSize: 22, fontWeight: 700, color }}>{cefr}</span>
        </div>
        <div style={{ fontSize: 13.5, color: '#5c6a61', maxWidth: 460, margin: '6px auto 0', lineHeight: 1.6 }}>{CEFR_DESC[cefr]}</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, margin: '18px 0' }}>
        <ScoreTile label="Reading" value={Math.round(result.reading_score ?? 0)} />
        <ScoreTile label="Writing" value={Math.round(result.writing_score ?? 0)} />
      </div>

      {ev && (
        <div style={{ borderTop: '1px solid #eef1ee', paddingTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#11241a', marginBottom: 6 }}>Feedback de tu escritura</div>
          {ev.overall_feedback && <p style={{ fontSize: 13.5, color: '#5c6a61', lineHeight: 1.65, margin: '0 0 12px' }}>{ev.overall_feedback}</p>}
          {ev.strengths?.length > 0 && <FeedList title="Lo que hiciste bien" items={ev.strengths} color={GREEN_DARK} />}
          {ev.areas_for_improvement?.length > 0 && <FeedList title="Para mejorar" items={ev.areas_for_improvement} color="#b45309" />}
        </div>
      )}

      <div style={{ marginTop: 18, textAlign: 'center', fontSize: 13.5, color: '#5c6a61', lineHeight: 1.6 }}>
        ¡Gracias por completar el test{name ? `, ${firstName(name)}` : ''}! Un asesor de DRC Academy se pondrá en contacto con vos.
      </div>
    </Card>
  );
}

function ScoreTile({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ background: '#f5f7f4', border: '1px solid #eef1ee', borderRadius: 12, padding: '14px 16px', textAlign: 'center' }}>
      <div style={{ fontSize: 24, fontWeight: 700, color: '#11241a' }}>{value}<span style={{ fontSize: 13, color: '#98a49b' }}>/100</span></div>
      <div style={{ fontSize: 12.5, color: '#5c6a61', marginTop: 2 }}>{label}</div>
    </div>
  );
}
function FeedList({ title, items, color }: { title: string; items: string[]; color: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color, marginBottom: 4 }}>{title}</div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#5c6a61', lineHeight: 1.6 }}>
        {items.map((it, i) => <li key={i}>{it}</li>)}
      </ul>
    </div>
  );
}

function ScoreGauge({ value, color }: { value: number; color: string }) {
  const r = 52, c = 2 * Math.PI * r, pct = Math.max(0, Math.min(100, value));
  return (
    <svg width={132} height={132} viewBox="0 0 132 132" style={{ display: 'inline-block' }}>
      <circle cx={66} cy={66} r={r} fill="none" stroke="#e3e7e0" strokeWidth={11} />
      <circle cx={66} cy={66} r={r} fill="none" stroke={color} strokeWidth={11} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} transform="rotate(-90 66 66)"
        style={{ transition: 'stroke-dashoffset 0.6s ease' }} />
      <text x={66} y={62} textAnchor="middle" fontSize={30} fontWeight={700} fill="#11241a">{value}</text>
      <text x={66} y={82} textAnchor="middle" fontSize={12} fill="#98a49b">de 100</text>
    </svg>
  );
}
