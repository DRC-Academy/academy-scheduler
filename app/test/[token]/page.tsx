'use client';

// Página PÚBLICA del Test de Nivel (link único, sin login). Estado 100% en
// Supabase vía la API (nada en localStorage): recargar retoma donde quedó.
// Flujo: Welcome → Reading (completion/passage/email, adaptativo) → Writing →
// Resultados. Diseño standalone con branding DRC (verde, Radio Canada), en línea
// visual con el formulario inicial. Español de España (tuteo).

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import type { LTQuestionPublic, LTProgress, WritingEvaluation, Cefr } from '@/lib/levelTest/types';
import { SECTION_LABEL, CEFR_DESC, CEFR_COLOR } from '@/lib/levelTest/constants';

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
    } catch { setError('No se pudo cargar el test. Revisa tu conexión.'); }
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
  if (phase === 'loading') return <LoadingScreen />;
  if (phase === 'invalid') return <StatusScreen emoji="🔒" title="Este enlace no es válido" text="Contacta con tu asesor de DRC Academy para obtener uno nuevo." />;
  if (phase === 'expired') return <StatusScreen emoji="⌛" title="Este enlace ya ha expirado" text="Pide uno nuevo a tu asesor de DRC Academy." />;

  if (phase === 'welcome') {
    return (
      <Shell>
        <CardHeader progress={null} />
        <div className="drc-t-content">
          <div className="drc-t-screen drc-t-anim">
            <span className="drc-t-chip">⏱ 20–30 minutos</span>
            <h1>{resuming ? `¡Seguimos, ${firstName(candidateName)}!` : `¡Hola${candidateName ? `, ${firstName(candidateName)}` : ''}! 👋`}</h1>
            <p>Este test evalúa tu nivel de inglés en <b>comprensión lectora</b> y <b>expresión escrita</b>. Al terminar sabrás al instante tu nivel según el marco europeo (CEFR).</p>
            <ul className="drc-t-list">
              <li><b>Comprensión lectora:</b> completar frases, textos y correos.</li>
              <li><b>Expresión escrita:</b> una redacción breve.</li>
              <li>Se adapta a tus respuestas: sube o baja de dificultad sobre la marcha.</li>
              <li>Una vez empieces, no podrás volver a preguntas anteriores.</li>
            </ul>
            {error && <ErrorLine>{error}</ErrorLine>}
          </div>
        </div>
        <div className="drc-t-nav start">
          <button className="drc-t-btn drc-t-btn-primary" onClick={loadCurrent} disabled={busy}>
            {busy ? 'Cargando…' : resuming ? 'Continuar el test →' : 'Empezar el test →'}
          </button>
        </div>
      </Shell>
    );
  }

  if (phase === 'results' && result) {
    return <ResultsScreen result={result} name={candidateName} />;
  }

  // testing
  if (phase === 'testing' && question && progress) {
    const isWriting = question.section === 'writing';
    const canSubmit = !busy && (isWriting ? countWords(written) >= (question.writing_min_words || 50) : selected != null);
    return (
      <Shell>
        <CardHeader progress={progress} />
        <div className="drc-t-content">
          <div key={question.id} className="drc-t-anim">
            <span className="drc-t-eyebrow">{SECTION_LABEL[question.section]}</span>

            {question.prompt_text && (
              <div className="drc-t-passage">{question.prompt_text}</div>
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
                <div className="drc-t-question">{question.question_text}</div>
                <div className="drc-t-opts">
                  {(question.options || []).map((opt, i) => (
                    <button key={i} type="button"
                      className={`drc-t-opt${selected === i ? ' sel' : ''}`}
                      onClick={() => setSelected(i)}>
                      <span className="drc-t-key" aria-hidden="true">{String.fromCharCode(65 + i)}</span>
                      <span className="drc-t-lbl">{opt}</span>
                      <span className="drc-t-check" aria-hidden="true">✓</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {error && <ErrorLine>{error}</ErrorLine>}
          </div>
        </div>
        <div className="drc-t-nav">
          <button className="drc-t-btn drc-t-btn-primary" onClick={submitAnswer} disabled={!canSubmit}>
            {busy ? (isWriting ? 'Evaluando…' : 'Guardando…') : 'Siguiente →'}
          </button>
        </div>
      </Shell>
    );
  }

  return <LoadingScreen />;
}

// ── Sub-componentes ──────────────────────────────────────────────────────────
function firstName(name: string): string { return (name || '').trim().split(/\s+/)[0] || ''; }
function countWords(s: string): number { const t = s.trim(); return t ? t.split(/\s+/).length : 0; }

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="drc-t-page">
      <TestStyles />
      <div className="drc-t-stage">
        <div className="drc-t-card">{children}</div>
        <div className="drc-t-footer">DRC Academy · Test de nivel de inglés</div>
      </div>
    </div>
  );
}

function CardHeader({ progress }: { progress: LTProgress | null }) {
  const pct = progress ? Math.round((progress.answeredTotal / progress.grandTotal) * 100) : 0;
  return (
    <div className="drc-t-head">
      <div className="drc-t-head-top">
        <div className="drc-t-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/drc-logo.png" alt="DRC Academy" className="drc-t-logo" />
          <div>
            <div className="drc-t-bname">DRC Academy</div>
            <div className="drc-t-bsub">Test de nivel</div>
          </div>
        </div>
        {progress && (
          <div className="drc-t-meta">
            <span className="drc-t-step">{SECTION_LABEL[progress.section]}</span>
            <span className="drc-t-pct">{pct}%</span>
          </div>
        )}
      </div>
      {progress && (
        <>
          <div className="drc-t-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="drc-t-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="drc-t-count">
            Sección {progress.sectionIndex + 1} de {progress.sectionTotal} · {progress.answeredTotal} / {progress.grandTotal} preguntas
          </div>
        </>
      )}
    </div>
  );
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return <div className="drc-t-err" role="alert">⚠️ {children}</div>;
}

function WritingSection({ prompt, minWords, value, onChange, busy }: {
  prompt: string; minWords: number; value: string; onChange: (v: string) => void; busy: boolean;
}) {
  const words = countWords(value);
  const ok = words >= minWords;
  return (
    <>
      <div className="drc-t-question">{prompt}</div>
      <div className="drc-t-hint">Escribe al menos {minWords} palabras en inglés.</div>
      <textarea
        className="drc-t-area"
        value={value} onChange={e => onChange(e.target.value)} disabled={busy} rows={10}
        placeholder="Write your answer here…"
      />
      <div className={`drc-t-words${ok ? ' ok' : ''}`}>
        {words} palabra{words === 1 ? '' : 's'}{ok ? ' ✓' : ` · faltan ${minWords - words}`}
      </div>
    </>
  );
}

function ResultsScreen({ result, name }: { result: Result; name: string }) {
  const cefr = (result.cefr_level || 'A1') as Cefr;
  const color = CEFR_COLOR[cefr] || '#1E9E3A';
  const overall = Math.round(result.overall_score ?? 0);
  const ev = result.ai_evaluation;
  return (
    <Shell>
      <CardHeader progress={null} />
      <div className="drc-t-content">
        <div className="drc-t-screen center drc-t-anim">
          <div className="drc-t-result-top">
            <ScoreGauge value={overall} color={color} />
            <div className="drc-t-level" style={{ background: `${color}14`, borderColor: `${color}55`, color }}>
              <span className="drc-t-level-lbl">Tu nivel</span>
              <span className="drc-t-level-val">{cefr}</span>
            </div>
          </div>
          <p className="drc-t-cefr-desc">{CEFR_DESC[cefr]}</p>

          <div className="drc-t-tiles">
            <ScoreTile label="Comprensión lectora" value={Math.round(result.reading_score ?? 0)} />
            <ScoreTile label="Expresión escrita" value={Math.round(result.writing_score ?? 0)} />
          </div>

          {ev && (
            <div className="drc-t-feedback">
              <div className="drc-t-feedback-h">Comentarios sobre tu redacción</div>
              {ev.overall_feedback && <p className="drc-t-feedback-p">{ev.overall_feedback}</p>}
              {ev.strengths?.length > 0 && <FeedList title="Lo que has hecho bien" items={ev.strengths} tone="ok" />}
              {ev.areas_for_improvement?.length > 0 && <FeedList title="Aspectos a mejorar" items={ev.areas_for_improvement} tone="warn" />}
            </div>
          )}

          <p className="drc-t-close">
            ¡Gracias por completar el test{name ? `, ${firstName(name)}` : ''}! Un asesor de DRC Academy se pondrá en contacto contigo muy pronto.
          </p>
        </div>
      </div>
    </Shell>
  );
}

function ScoreTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="drc-t-tile">
      <div className="drc-t-tile-val">{value}<span className="drc-t-tile-max">/100</span></div>
      <div className="drc-t-tile-lbl">{label}</div>
    </div>
  );
}
function FeedList({ title, items, tone }: { title: string; items: string[]; tone: 'ok' | 'warn' }) {
  return (
    <div className={`drc-t-feed drc-t-feed-${tone}`}>
      <div className="drc-t-feed-h">{title}</div>
      <ul>{items.map((it, i) => <li key={i}>{it}</li>)}</ul>
    </div>
  );
}

function ScoreGauge({ value, color }: { value: number; color: string }) {
  const r = 58, c = 2 * Math.PI * r, pct = Math.max(0, Math.min(100, value));
  return (
    <svg width={148} height={148} viewBox="0 0 148 148" className="drc-t-gauge">
      <circle cx={74} cy={74} r={r} fill="none" stroke="#e3e7e0" strokeWidth={12} />
      <circle cx={74} cy={74} r={r} fill="none" stroke={color} strokeWidth={12} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} transform="rotate(-90 74 74)"
        style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.4,0,0.2,1)' }} />
      <text x={74} y={72} textAnchor="middle" fontSize={34} fontWeight={800} fill="#11241a">{value}</text>
      <text x={74} y={92} textAnchor="middle" fontSize={12} fill="#98a49b">de 100</text>
    </svg>
  );
}

function StatusScreen({ emoji, title, text }: { emoji: string; title: string; text: string }) {
  return (
    <Shell>
      <CardHeader progress={null} />
      <div className="drc-t-content">
        <div className="drc-t-screen center drc-t-anim">
          <div className="drc-t-big">{emoji}</div>
          <h1>{title}</h1>
          <p className="drc-t-muted">{text}</p>
        </div>
      </div>
    </Shell>
  );
}

function LoadingScreen() {
  return (
    <div className="drc-t-page" style={{ alignItems: 'center' }}>
      <TestStyles />
      <div className="drc-t-spin">
        <div className="ring" />
        <div className="txt">Cargando…</div>
      </div>
    </div>
  );
}

function TestStyles() {
  return <style dangerouslySetInnerHTML={{ __html: TEST_CSS }} />;
}

const TEST_CSS = `
.drc-t-page {
  min-height: 100dvh;
  background: #EFF0EB;
  color: #191A17;
  font-family: 'Radio Canada', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  display: flex; align-items: center; justify-content: center;
  padding: 40px 20px;
}
.drc-t-stage { width: 100%; max-width: 760px; }
.drc-t-card {
  display: flex; flex-direction: column;
  background: #fff; border: 1px solid #E4E4DD; border-radius: 22px;
  box-shadow: 0 24px 64px rgba(20, 40, 20, 0.13);
  overflow: hidden;
}
.drc-t-footer { text-align: center; font-size: 12px; color: #83847A; padding: 16px 20px 0; }

/* Header */
.drc-t-head {
  position: relative; padding: 20px 34px 18px; background: #FCFCFA;
  border-bottom: 1px solid #E4E4DD;
  display: flex; flex-direction: column; gap: 12px;
}
.drc-t-head::before {
  content: ""; position: absolute; left: 0; top: 0; right: 0; height: 4px;
  background: linear-gradient(90deg, #1E9E3A, #1E9E3A 60%, #FFC400);
}
.drc-t-head-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.drc-t-brand { display: flex; align-items: center; gap: 11px; }
.drc-t-logo { height: 36px; width: auto; display: block; }
.drc-t-bname { font-size: 15.5px; font-weight: 800; line-height: 1.15; }
.drc-t-bsub { font-size: 12px; color: #83847A; }
.drc-t-meta { display: flex; align-items: baseline; gap: 10px; white-space: nowrap; }
.drc-t-step { font-size: 12.5px; font-weight: 700; color: #46473F; }
.drc-t-pct { font-size: 17px; font-weight: 800; color: #1E9E3A; font-variant-numeric: tabular-nums; }
.drc-t-track {
  height: 11px; border-radius: 999px; background: #FBFBF9;
  box-shadow: inset 0 0 0 1px #E4E4DD; overflow: hidden; position: relative;
}
.drc-t-fill {
  height: 100%; border-radius: 999px; min-width: 11px; position: relative;
  background: linear-gradient(90deg, #167a2d, #1E9E3A 70%, #34c256);
  transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}
.drc-t-fill::after {
  content: ""; position: absolute; right: 2px; top: 50%; transform: translateY(-50%);
  width: 5px; height: 5px; border-radius: 50%; background: #FFC400;
  box-shadow: 0 0 6px 1px rgba(255, 196, 0, 0.8);
}
.drc-t-count { font-size: 11.5px; color: #83847A; }

/* Content */
.drc-t-content { padding: 32px 40px; }
.drc-t-eyebrow {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.09em;
  color: #167a2d; background: rgba(30, 158, 58, 0.08);
  padding: 6px 12px; border-radius: 999px; margin-bottom: 18px;
}
.drc-t-passage {
  background: #f6f8f5; border: 1px solid #E9EDE7; border-left: 3px solid #1E9E3A;
  border-radius: 12px; padding: 16px 18px; margin-bottom: 20px;
  font-size: 15px; color: #22271f; line-height: 1.7; white-space: pre-wrap;
}
.drc-t-question { font-size: 18px; font-weight: 700; color: #191A17; margin: 0 0 18px; line-height: 1.45; letter-spacing: -0.2px; }
.drc-t-hint { font-size: 13.5px; color: #83847A; margin: -8px 0 14px; }

/* Transición entre pasos */
.drc-t-anim { animation: drc-t-in 0.4s cubic-bezier(0.22, 0.61, 0.36, 1); }
@keyframes drc-t-in { from { opacity: 0; transform: translateY(9px); } to { opacity: 1; transform: translateY(0); } }

/* Opciones */
.drc-t-opts { display: flex; flex-direction: column; gap: 11px; }
.drc-t-opt {
  display: flex; align-items: center; gap: 14px; width: 100%; text-align: left;
  padding: 14px 16px; border-radius: 13px; border: 1.5px solid #E4E4DD;
  background: #fff; color: #191A17; font-family: inherit; font-size: 15.5px; font-weight: 500;
  line-height: 1.4; cursor: pointer; box-shadow: 0 1px 2px rgba(20, 30, 15, 0.05);
  transition: border-color 0.16s, background 0.16s, transform 0.14s, box-shadow 0.16s;
}
.drc-t-opt:hover { border-color: #1E9E3A; background: rgba(30, 158, 58, 0.06); transform: translateY(-1px); box-shadow: 0 8px 26px rgba(20, 40, 20, 0.10); }
.drc-t-opt:focus-visible { outline: none; border-color: #1E9E3A; box-shadow: 0 0 0 3px rgba(255, 196, 0, 0.55); }
.drc-t-opt.sel { border-color: #1E9E3A; border-width: 2px; background: rgba(30, 158, 58, 0.12); font-weight: 600; padding: 13px 15px; }
.drc-t-key {
  flex-shrink: 0; width: 27px; height: 27px; border-radius: 8px; background: #F0F1EC; color: #6b7d6f;
  display: grid; place-items: center; font-size: 13px; font-weight: 800;
  transition: background 0.16s, color 0.16s;
}
.drc-t-opt:hover .drc-t-key { background: rgba(30, 158, 58, 0.14); color: #167a2d; }
.drc-t-opt.sel .drc-t-key { background: #1E9E3A; color: #fff; }
.drc-t-lbl { flex: 1; }
.drc-t-check { flex-shrink: 0; color: #1E9E3A; font-weight: 800; font-size: 14px; opacity: 0; transform: translateX(-4px); transition: opacity 0.16s, transform 0.16s; }
.drc-t-opt.sel .drc-t-check { opacity: 1; transform: translateX(0); }

/* Writing */
.drc-t-area {
  width: 100%; padding: 15px 17px; border-radius: 13px; box-sizing: border-box;
  border: 1.5px solid #E4E4DD; background: #fff; font-family: inherit; font-size: 15.5px; color: #191A17;
  line-height: 1.6; resize: vertical; min-height: 200px;
  box-shadow: 0 1px 2px rgba(20, 30, 15, 0.05); transition: border-color 0.16s, box-shadow 0.16s;
}
.drc-t-area:focus { outline: none; border-color: #1E9E3A; box-shadow: 0 0 0 3px rgba(255, 196, 0, 0.4); }
.drc-t-words { font-size: 13px; color: #98a49b; margin-top: 8px; font-weight: 600; }
.drc-t-words.ok { color: #167a2d; }

/* Error */
.drc-t-err {
  margin-top: 18px; padding: 12px 15px; border-radius: 11px;
  background: rgba(192, 57, 43, 0.08); border: 1px solid rgba(192, 57, 43, 0.35);
  color: #C0392B; font-size: 14px; font-weight: 600;
  display: flex; align-items: center; gap: 8px;
}

/* Nav */
.drc-t-nav {
  display: flex; gap: 12px; align-items: center; justify-content: flex-end;
  padding: 18px 40px; border-top: 1px solid #E4E4DD; background: #fff;
}
.drc-t-nav.start { justify-content: flex-start; }
.drc-t-btn {
  appearance: none; font-family: inherit; font-weight: 700; border-radius: 12px; cursor: pointer;
  padding: 13px 30px; font-size: 15px; min-height: 50px;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  transition: transform 0.14s, box-shadow 0.16s, background 0.16s, border-color 0.16s;
}
.drc-t-btn-primary { background: #1E9E3A; border: 1.5px solid #1E9E3A; color: #fff; box-shadow: 0 6px 16px rgba(30, 158, 58, 0.28); }
.drc-t-btn-primary:hover { background: #167a2d; transform: translateY(-1px); box-shadow: 0 10px 22px rgba(30, 158, 58, 0.36); }
.drc-t-btn-primary:disabled { background: #c8d3cb; border-color: #c8d3cb; box-shadow: none; cursor: not-allowed; transform: none; }
.drc-t-btn:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(255, 196, 0, 0.6); }

/* Pantallas (welcome / estado / resultados) */
.drc-t-screen { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.drc-t-screen.center { align-items: center; text-align: center; }
.drc-t-big { font-size: 52px; line-height: 1; margin-bottom: 8px; }
.drc-t-screen h1 { margin: 4px 0 12px; font-size: clamp(23px, 3vw, 30px); font-weight: 800; letter-spacing: -0.5px; line-height: 1.2; }
.drc-t-screen p { margin: 0 0 12px; font-size: 16px; color: #46473F; max-width: 58ch; line-height: 1.65; }
.drc-t-screen p.drc-t-muted { color: #83847A; }
.drc-t-chip {
  display: inline-flex; align-items: center; gap: 7px; background: rgba(30, 158, 58, 0.08);
  color: #167a2d; font-size: 13px; font-weight: 700; padding: 7px 14px; border-radius: 999px; margin-bottom: 18px;
}
.drc-t-list { margin: 4px 0 4px; padding-left: 20px; font-size: 15px; color: #46473F; line-height: 1.9; max-width: 58ch; }
.drc-t-list li { margin-bottom: 2px; }

/* Resultados */
.drc-t-result-top { display: flex; flex-direction: column; align-items: center; gap: 14px; margin-bottom: 6px; }
.drc-t-gauge { display: block; }
.drc-t-level {
  display: inline-flex; align-items: center; gap: 9px; border: 1.5px solid; border-radius: 999px; padding: 7px 18px;
}
.drc-t-level-lbl { font-size: 13px; font-weight: 700; opacity: 0.85; }
.drc-t-level-val { font-size: 22px; font-weight: 800; letter-spacing: -0.3px; }
.drc-t-cefr-desc { font-size: 14.5px; color: #5c6a61; max-width: 48ch; margin: 4px auto 0; line-height: 1.6; }
.drc-t-tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; width: 100%; margin: 22px 0 6px; }
.drc-t-tile { background: #f6f8f5; border: 1px solid #E9EDE7; border-radius: 14px; padding: 16px 14px; text-align: center; }
.drc-t-tile-val { font-size: 27px; font-weight: 800; color: #11241a; letter-spacing: -0.5px; }
.drc-t-tile-max { font-size: 13px; font-weight: 600; color: #98a49b; }
.drc-t-tile-lbl { font-size: 12.5px; color: #5c6a61; margin-top: 3px; font-weight: 600; }

.drc-t-feedback { width: 100%; text-align: left; border-top: 1px solid #E4E4DD; margin-top: 20px; padding-top: 18px; }
.drc-t-feedback-h { font-size: 14px; font-weight: 800; color: #11241a; margin-bottom: 8px; }
.drc-t-feedback-p { font-size: 14.5px; color: #46473F; line-height: 1.7; margin: 0 0 14px; max-width: none; }
.drc-t-feed { border-radius: 12px; padding: 13px 15px; margin-bottom: 10px; }
.drc-t-feed-ok { background: rgba(30, 158, 58, 0.07); border: 1px solid rgba(30, 158, 58, 0.22); }
.drc-t-feed-warn { background: rgba(180, 83, 9, 0.06); border: 1px solid rgba(180, 83, 9, 0.22); }
.drc-t-feed-h { font-size: 12.5px; font-weight: 800; margin-bottom: 5px; }
.drc-t-feed-ok .drc-t-feed-h { color: #167a2d; }
.drc-t-feed-warn .drc-t-feed-h { color: #b45309; }
.drc-t-feed ul { margin: 0; padding-left: 18px; font-size: 13.5px; color: #46473F; line-height: 1.65; }
.drc-t-close { font-size: 14.5px; color: #46473F; line-height: 1.65; margin-top: 20px; max-width: 52ch; }

/* Spinner */
.drc-t-spin { display: flex; flex-direction: column; align-items: center; gap: 14px; }
.drc-t-spin .ring { width: 34px; height: 34px; border: 3px solid #E4E4DD; border-top-color: #1E9E3A; border-radius: 50%; animation: drc-t-rot 0.8s linear infinite; }
.drc-t-spin .txt { font-size: 14px; color: #83847A; }
@keyframes drc-t-rot { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .drc-t-anim, .drc-t-spin .ring { animation: none; }
  .drc-t-fill, .drc-t-gauge circle { transition: none; }
}

/* Mobile */
@media (max-width: 767px) {
  .drc-t-page { padding: 0; align-items: stretch; }
  .drc-t-stage { max-width: none; }
  .drc-t-card { border-radius: 0; border: 0; box-shadow: none; min-height: 100dvh; }
  .drc-t-head { padding: 15px 18px 14px; padding-top: max(15px, env(safe-area-inset-top)); }
  .drc-t-bsub { display: none; }
  .drc-t-content { padding: 24px 18px; flex: 1; }
  .drc-t-question { font-size: 16.5px; }
  .drc-t-tiles { grid-template-columns: 1fr; }
  .drc-t-nav {
    position: sticky; bottom: 0; padding: 12px 18px;
    padding-bottom: max(12px, env(safe-area-inset-bottom));
    box-shadow: 0 -6px 18px rgba(0, 0, 0, 0.05);
  }
  .drc-t-btn { flex: 1; }
  .drc-t-footer { display: none; }
}
`;
