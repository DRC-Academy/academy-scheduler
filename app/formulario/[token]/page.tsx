'use client';

// Página PÚBLICA del formulario inicial del alumno (link único).
// No requiere login. Rediseño integral: card único ancho, responsive real
// (mobile <768 / tablet / desktop ≥1024) con branding DRC.

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { resolveFormVariant, questionsOf, firstUnansweredRequired, type FormResponses, type FormQuestion } from '@/lib/formQuestions';

// ── Emojis por habilidad (detalle visual de la matriz — no se toca formQuestions) ──
const SKILL_EMOJI: Record<string, string> = {
  'Hablar': '🗣',
  'Escuchar': '👂',
  'Leer': '📖',
  'Escribir': '✍️',
};

interface TokenRow {
  id: string;
  token: string;
  student_name: string;
  teacher_name: string;
  plan: string | null;
  level: string | null;
  status: string;
  expires_at: string | null;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'done' }               // token ya completado
  | { kind: 'ready'; token: TokenRow };

export default function FormularioPage() {
  const params = useParams<{ token: string }>();
  const token = Array.isArray(params.token) ? params.token[0] : params.token;

  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) { setState({ kind: 'invalid' }); return; }
      const { data, error } = await supabase
        .from('form_tokens')
        .select('id, token, student_name, teacher_name, plan, level, status, expires_at')
        .eq('token', token)
        .maybeSingle();

      if (cancelled) return;
      if (error || !data) { setState({ kind: 'invalid' }); return; }
      if (data.status === 'completed') { setState({ kind: 'done' }); return; }
      const expired = data.expires_at && new Date(data.expires_at).getTime() < Date.now();
      if (data.status === 'expired' || expired) { setState({ kind: 'invalid' }); return; }
      setState({ kind: 'ready', token: data as TokenRow });
    })();
    return () => { cancelled = true; };
  }, [token]);

  if (state.kind === 'loading') return <LoadingScreen />;
  if (state.kind === 'invalid') return <ErrorScreen />;
  if (state.kind === 'done') return <AlreadyDoneScreen />;
  return <FormFlow token={state.token} />;
}

// ── Flujo del formulario (una pregunta a la vez) ────────────────────────────────
function FormFlow({ token }: { token: TokenRow }) {
  // Qué formulario le toca a este alumno, según el plan guardado en su token
  // (inglés general, B1 Preliminary, …). Ver lib/formQuestions/index.ts.
  const questions = questionsOf(resolveFormVariant({ plan: token.plan }));
  const total = questions.length;
  const [step, setStep] = useState(-1);   // -1 = pantalla de bienvenida
  const [responses, setResponses] = useState<FormResponses>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [testUrl, setTestUrl] = useState<string | null>(null);

  const q = step >= 0 && step < total ? questions[step] : null;

  function setAnswer(id: string, value: unknown) {
    setResponses(prev => ({ ...prev, [id]: value }));
    setError(null);
  }

  function isAnswered(question: FormQuestion): boolean {
    const v = responses[question.id];
    if (question.type === 'checkbox') return Array.isArray(v) && v.length > 0;
    if (question.type === 'matrix') {
      const obj = (v ?? {}) as Record<string, string>;
      return (question.rows ?? []).every(r => obj[r]);
    }
    return v != null && String(v).trim() !== '';
  }

  function next() {
    if (q && q.required && !isAnswered(q)) {
      setError('Esta pregunta es obligatoria 🙂');
      return;
    }
    setError(null);
    setStep(s => s + 1);
  }
  function prev() { setError(null); setStep(s => s - 1); }

  async function submit() {
    const missing = firstUnansweredRequired(responses, questions);
    if (missing) {
      setError(`Falta responder: ${missing.title}`);
      const idx = questions.findIndex(x => x.id === missing.id);
      if (idx >= 0) setStep(idx);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/forms/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: token.token, responses }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || 'No se pudieron enviar tus respuestas. Inténtalo de nuevo.');
        setSubmitting(false);
        return;
      }
      setTestUrl(typeof data?.testUrl === 'string' ? data.testUrl : null);
      setSent(true);
    } catch {
      setError('No hay conexión. Revisa tu internet e inténtalo de nuevo.');
      setSubmitting(false);
    }
  }

  if (sent) return <ThankYouScreen studentName={token.student_name} teacherName={token.teacher_name} testUrl={testUrl} />;

  const progress =
    step < 0 ? null
    : step >= total ? { label: 'Revisión final', pct: 100 }
    : { label: `Pregunta ${step + 1} de ${total}`, pct: Math.round(((step + 1) / total) * 100) };

  const isLast = step === total - 1;

  return (
    <Shell>
      <CardHeader progress={progress} />

      <div className="drc-f-content">
        <div key={step} className="drc-f-anim">
          {step === -1 ? (
            <WelcomeInner token={token} />
          ) : step >= total ? (
            <ReviewInner teacherName={token.teacher_name} />
          ) : q ? (
            <QuestionInner
              question={q}
              value={responses[q.id]}
              onChange={v => setAnswer(q.id, v)}
            />
          ) : null}

          {error && <div className="drc-f-err" role="alert">⚠️ {error}</div>}
        </div>
      </div>

      {step === -1 ? (
        <div className="drc-f-nav start">
          <button className="drc-f-btn drc-f-btn-primary" onClick={() => setStep(0)}>Empezar →</button>
        </div>
      ) : step >= total ? (
        <div className="drc-f-nav">
          <button className="drc-f-btn drc-f-btn-ghost" disabled={submitting} onClick={() => setStep(total - 1)}>
            ← Volver a revisar
          </button>
          <button className="drc-f-btn drc-f-btn-primary" disabled={submitting} onClick={submit}>
            {submitting ? 'Enviando…' : 'Enviar respuestas ✨'}
          </button>
        </div>
      ) : (
        <div className="drc-f-nav">
          <button className="drc-f-btn drc-f-btn-ghost" onClick={prev}>← Anterior</button>
          <button className="drc-f-btn drc-f-btn-primary" onClick={next}>
            {isLast ? 'Revisar ✓' : 'Siguiente →'}
          </button>
        </div>
      )}
    </Shell>
  );
}

// ── Contenido de pantallas ──────────────────────────────────────────────────────
function WelcomeInner({ token }: { token: TokenRow }) {
  return (
    <div className="drc-f-screen">
      <span className="drc-f-chip">⏱ 5 minutos</span>
      <h1>Hola, {token.student_name}. 👋</h1>
      <p>Soy Diego, el director de DRC Academy. Antes de tu primera clase con <b>{token.teacher_name}</b> me gustaría conocerte un poco.</p>
      <p>Con esto prepararemos una clase pensada para ti desde el primer minuto.</p>
      <p className="drc-f-muted">Son once preguntas y solo te llevará cinco minutos. Responde con sinceridad, para que podamos personalizar tu clase.</p>
    </div>
  );
}

function ReviewInner({ teacherName }: { teacherName: string }) {
  return (
    <div className="drc-f-screen center">
      <div className="drc-f-big">🎉</div>
      <h1>Ya está.</h1>
      <p>Has llegado al final. Cuando quieras, envíame tus respuestas y se las paso a {teacherName} para que prepare tu primera clase.</p>
    </div>
  );
}

function QuestionInner({ question, value, onChange }: {
  question: FormQuestion;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  return (
    <>
      <span className="drc-f-eyebrow">{question.section}</span>
      <h1 className="drc-f-title">
        {question.title}
        {!question.required && <span className="drc-f-opttag"> (opcional)</span>}
      </h1>
      {question.hint
        ? <p className="drc-f-hint">{question.hint}</p>
        : <div style={{ height: 6 }} />}
      <QuestionInput question={question} value={value} onChange={onChange} />
    </>
  );
}

// ── Inputs por tipo de pregunta ─────────────────────────────────────────────────
function QuestionInput({ question, value, onChange }: {
  question: FormQuestion;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  if (question.type === 'short') {
    return (
      <input
        type="text"
        className="drc-f-txt"
        value={(value as string) ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder="Escribe tu respuesta…"
        autoFocus
      />
    );
  }
  if (question.type === 'long') {
    return (
      <textarea
        className="drc-f-txt drc-f-area"
        value={(value as string) ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder="Escribe tu respuesta…"
        rows={5}
        autoFocus
      />
    );
  }
  if (question.type === 'radio' || question.type === 'checkbox') {
    return <ChoiceGroup question={question} value={value} onChange={onChange} multi={question.type === 'checkbox'} />;
  }
  if (question.type === 'matrix') {
    return <MatrixInput question={question} value={value} onChange={onChange} />;
  }
  return null;
}

// Selección única (radio) o múltiple (checkbox), con navegación por teclado.
function ChoiceGroup({ question, value, onChange, multi }: {
  question: FormQuestion;
  value: unknown;
  onChange: (v: unknown) => void;
  multi: boolean;
}) {
  const opts = question.options ?? [];
  const ref = useRef<HTMLDivElement>(null);
  const arr = multi && Array.isArray(value) ? (value as string[]) : [];
  const selected = multi ? undefined : (value as string | undefined);
  const twoCol = multi && opts.length > 4;

  const focusIdx = (i: number) =>
    ref.current?.querySelectorAll<HTMLButtonElement>('.drc-f-opt')[i]?.focus();

  const toggle = (opt: string) => {
    if (multi) onChange(arr.includes(opt) ? arr.filter(o => o !== opt) : [...arr, opt]);
    else onChange(opt);
  };

  // Patrón radiogroup: flechas mueven foco y seleccionan; Enter/Espacio selecciona.
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(opts[i]); return; }
    if (multi) return; // en checkbox, Tab recorre y click nativo alterna
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault(); const n = (i + 1) % opts.length; focusIdx(n); onChange(opts[n]);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault(); const n = (i - 1 + opts.length) % opts.length; focusIdx(n); onChange(opts[n]);
    }
  };

  return (
    <div ref={ref} className={`drc-f-opts${twoCol ? ' two' : ''}`} role={multi ? 'group' : 'radiogroup'} aria-label={question.title}>
      {opts.map((opt, i) => {
        const sel = multi ? arr.includes(opt) : selected === opt;
        const tab = multi ? 0 : (sel || (!selected && i === 0) ? 0 : -1);
        return (
          <button
            key={opt}
            type="button"
            className={`drc-f-opt${multi ? ' cb' : ''}${sel ? ' sel' : ''}`}
            role={multi ? 'checkbox' : 'radio'}
            aria-checked={sel}
            tabIndex={tab}
            onClick={() => toggle(opt)}
            onKeyDown={e => onKey(e, i)}
          >
            <span className="drc-f-ind" aria-hidden="true" />
            <span className="drc-f-lbl">{opt}</span>
            <span className="drc-f-checkmark" aria-hidden="true">✓</span>
          </button>
        );
      })}
    </div>
  );
}

// Matriz de habilidades: una fila radiogroup por habilidad, 5 niveles compartidos.
function MatrixInput({ question, value, onChange }: {
  question: FormQuestion;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const obj = (value ?? {}) as Record<string, string>;
  const cols = question.cols ?? [];
  return (
    <div className="drc-f-matrix">
      {(question.rows ?? []).map(row => (
        <LevelRow
          key={row}
          row={row}
          cols={cols}
          selected={obj[row]}
          onSelect={col => onChange({ ...obj, [row]: col })}
        />
      ))}
    </div>
  );
}

function LevelRow({ row, cols, selected, onSelect }: {
  row: string;
  cols: string[];
  selected: string | undefined;
  onSelect: (col: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const focusIdx = (i: number) =>
    ref.current?.querySelectorAll<HTMLButtonElement>('.drc-f-lvl')[i]?.focus();

  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); const n = Math.min(i + 1, cols.length - 1); focusIdx(n); onSelect(cols[n]); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); const n = Math.max(i - 1, 0); focusIdx(n); onSelect(cols[n]); }
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onSelect(cols[i]); }
  };

  return (
    <div className="drc-f-mrow">
      <div className="drc-f-mlabel">
        <span className="drc-f-mi" aria-hidden="true">{SKILL_EMOJI[row] ?? ''}</span>{row}
      </div>
      <div ref={ref} className="drc-f-levels" role="radiogroup" aria-label={row}>
        {cols.map((c, i) => {
          const sel = selected === c;
          const tab = sel || (!selected && i === 0) ? 0 : -1;
          return (
            <button
              key={c}
              type="button"
              className={`drc-f-lvl${sel ? ' sel' : ''}`}
              role="radio"
              aria-checked={sel}
              tabIndex={tab}
              onClick={() => onSelect(c)}
              onKeyDown={e => onKey(e, i)}
            >
              {c}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Pantallas de estado (gracias / error / ya completado / cargando) ────────────
function ThankYouScreen({ studentName, teacherName, testUrl }: { studentName: string; teacherName: string; testUrl: string | null }) {
  return (
    <Shell>
      <CardHeader progress={null} />
      <div className="drc-f-content">
        <div className="drc-f-screen center drc-f-anim">
          <div className="drc-f-big">🎉</div>
          <h1>Gracias, {studentName}.</h1>
          <p>Ya tengo todo lo que necesitaba. Se lo hago llegar a {teacherName} para que prepare tu primera clase y empieces con buen pie.</p>

          {testUrl ? (
            <div className="drc-f-cta">
              <div className="drc-f-cta-badge">🎯 Último paso recomendado</div>
              <div className="drc-f-cta-title">Descubre tu nivel de inglés</div>
              <p className="drc-f-cta-text">
                Haz ahora un breve <b>test de nivel</b>: en unos minutos sabrás al instante en qué nivel te
                encuentras y nos ayudará a preparar tu primera clase a tu medida.
              </p>
              <a className="drc-f-btn drc-f-btn-primary drc-f-cta-btn" href={testUrl}>
                Hacer el test de nivel →
              </a>
              <div className="drc-f-cta-note">Tarda unos 20 minutos · Puedes hacerlo también más tarde desde este enlace.</div>
            </div>
          ) : (
            <p>Nos vemos muy pronto.</p>
          )}

          <p className="drc-f-sig">Diego Ruiz. Director de DRC Academy.</p>
        </div>
      </div>
    </Shell>
  );
}

function ErrorScreen() {
  return (
    <Shell>
      <CardHeader progress={null} />
      <div className="drc-f-content">
        <div className="drc-f-screen center drc-f-anim">
          <div className="drc-f-big">🔒</div>
          <h1>Este enlace ya no está disponible</h1>
          <p className="drc-f-muted">Contacta con tu profesor para obtener uno nuevo.</p>
        </div>
      </div>
    </Shell>
  );
}

function AlreadyDoneScreen() {
  return (
    <Shell>
      <CardHeader progress={null} />
      <div className="drc-f-content">
        <div className="drc-f-screen center drc-f-anim">
          <div className="drc-f-big">✅</div>
          <h1>Ya has completado el formulario.</h1>
          <p className="drc-f-muted">Gracias por tus respuestas. Ya las tengo y se las he pasado a tu profe. Nos vemos en clase.</p>
        </div>
      </div>
    </Shell>
  );
}

function LoadingScreen() {
  return (
    <div className="drc-f-page" style={{ alignItems: 'center' }}>
      <FormStyles />
      <div className="drc-f-spin">
        <div className="ring" />
        <div className="txt">Cargando…</div>
      </div>
    </div>
  );
}

// ── Chrome compartido ───────────────────────────────────────────────────────────
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="drc-f-page">
      <FormStyles />
      <div className="drc-f-stage">
        <div className="drc-f-card">{children}</div>
        <div className="drc-f-footer">DRC Academy · Plataforma de gestión interna</div>
      </div>
    </div>
  );
}

function CardHeader({ progress }: { progress: { label: string; pct: number } | null }) {
  return (
    <div className="drc-f-head">
      <div className="drc-f-head-top">
        <div className="drc-f-brand">
          <div className="drc-f-logo">DRC</div>
          <div>
            <div className="drc-f-bname">DRC Academy</div>
            <div className="drc-f-bsub">Formulario inicial</div>
          </div>
        </div>
        {progress && (
          <div className="drc-f-meta">
            <span className="drc-f-step">{progress.label}</span>
            <span className="drc-f-pct">{progress.pct}%</span>
          </div>
        )}
      </div>
      {progress && (
        <div className="drc-f-track" role="progressbar" aria-valuenow={progress.pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="drc-f-fill" style={{ width: `${progress.pct}%` }} />
        </div>
      )}
    </div>
  );
}

// ── Estilos (bloque <style> — inline no soporta :hover/:focus/@media) ────────────
function FormStyles() {
  return <style dangerouslySetInnerHTML={{ __html: FORM_CSS }} />;
}

const FORM_CSS = `
.drc-f-page {
  min-height: 100dvh;
  background: #EFF0EB;
  color: #191A17;
  font-family: 'Radio Canada', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  display: flex; align-items: center; justify-content: center;
  padding: 40px 20px;
}
.drc-f-stage { width: 100%; max-width: 940px; }
.drc-f-card {
  display: flex; flex-direction: column;
  background: #fff; border: 1px solid #E4E4DD; border-radius: 22px;
  box-shadow: 0 24px 64px rgba(20, 40, 20, 0.13);
  overflow: hidden;
}
.drc-f-footer { text-align: center; font-size: 12px; color: #83847A; padding: 16px 20px 0; }

/* Header */
.drc-f-head {
  position: relative; padding: 20px 34px 18px; background: #FCFCFA;
  border-bottom: 1px solid #E4E4DD;
  display: flex; flex-direction: column; gap: 14px;
}
.drc-f-head::before {
  content: ""; position: absolute; left: 0; top: 0; right: 0; height: 4px;
  background: linear-gradient(90deg, #1E9E3A, #1E9E3A 60%, #FFC400);
}
.drc-f-head-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.drc-f-brand { display: flex; align-items: center; gap: 11px; }
.drc-f-logo {
  width: 40px; height: 40px; border-radius: 11px; background: #1E9E3A; color: #fff;
  display: grid; place-items: center; font-weight: 800; font-size: 14px; letter-spacing: -0.5px;
  box-shadow: 0 3px 8px rgba(30, 158, 58, 0.3);
}
.drc-f-bname { font-size: 15.5px; font-weight: 800; line-height: 1.15; }
.drc-f-bsub { font-size: 12px; color: #83847A; }
.drc-f-meta { display: flex; align-items: baseline; gap: 10px; white-space: nowrap; }
.drc-f-step { font-size: 13px; font-weight: 700; color: #46473F; }
.drc-f-pct { font-size: 17px; font-weight: 800; color: #1E9E3A; font-variant-numeric: tabular-nums; }
.drc-f-track {
  height: 11px; border-radius: 999px; background: #FBFBF9;
  box-shadow: inset 0 0 0 1px #E4E4DD; overflow: hidden; position: relative;
}
.drc-f-fill {
  height: 100%; border-radius: 999px; min-width: 11px; position: relative;
  background: linear-gradient(90deg, #167a2d, #1E9E3A 70%, #34c256);
  transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}
.drc-f-fill::after {
  content: ""; position: absolute; right: 2px; top: 50%; transform: translateY(-50%);
  width: 5px; height: 5px; border-radius: 50%; background: #FFC400;
  box-shadow: 0 0 6px 1px rgba(255, 196, 0, 0.8);
}

/* Content */
.drc-f-content { padding: 34px 40px; }
.drc-f-eyebrow {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.09em;
  color: #167a2d; background: rgba(30, 158, 58, 0.08);
  padding: 6px 12px; border-radius: 999px; margin-bottom: 16px;
}
.drc-f-title {
  margin: 0 0 10px; font-size: clamp(22px, 2.5vw, 30px); font-weight: 800;
  letter-spacing: -0.4px; line-height: 1.2; color: #191A17; max-width: 24ch;
}
.drc-f-opttag { font-size: 13px; font-weight: 600; color: #83847A; letter-spacing: 0; text-transform: none; }
.drc-f-hint { margin: 0 0 26px; font-size: 15.5px; color: #46473F; line-height: 1.55; max-width: 62ch; }

/* Transición entre pasos */
.drc-f-anim { animation: drc-f-in 0.42s cubic-bezier(0.22, 0.61, 0.36, 1); }
@keyframes drc-f-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

/* Opciones (radio / checkbox) */
.drc-f-opts { display: flex; flex-direction: column; gap: 11px; max-width: 640px; }
.drc-f-opt {
  display: flex; align-items: center; gap: 14px; width: 100%; text-align: left;
  padding: 15px 17px; border-radius: 14px; border: 1.5px solid #E4E4DD;
  background: #fff; color: #191A17; font-family: inherit; font-size: 15.5px; font-weight: 500;
  line-height: 1.35; cursor: pointer; box-shadow: 0 1px 2px rgba(20, 30, 15, 0.05);
  transition: border-color 0.16s, background 0.16s, transform 0.14s, box-shadow 0.16s;
}
.drc-f-opt:hover { border-color: #1E9E3A; background: rgba(30, 158, 58, 0.08); transform: translateY(-1px); box-shadow: 0 8px 30px rgba(20, 40, 20, 0.10); }
.drc-f-opt:focus-visible { outline: none; border-color: #1E9E3A; box-shadow: 0 0 0 3px rgba(255, 196, 0, 0.55); }
.drc-f-opt.sel { border-color: #1E9E3A; border-width: 2px; background: rgba(30, 158, 58, 0.14); font-weight: 600; padding: 14px 16px; }
.drc-f-ind {
  flex-shrink: 0; width: 24px; height: 24px; border-radius: 50%; border: 2px solid #D2D2CA;
  display: grid; place-items: center; transition: border-color 0.16s, background 0.16s;
}
.drc-f-opt.cb .drc-f-ind { border-radius: 7px; }
.drc-f-opt:hover .drc-f-ind { border-color: #1E9E3A; }
.drc-f-opt.sel .drc-f-ind { border-color: #1E9E3A; background: #1E9E3A; }
.drc-f-ind::after { content: ""; opacity: 0; transform: scale(0.4); transition: opacity 0.16s, transform 0.16s; }
.drc-f-opt.sel:not(.cb) .drc-f-ind::after { opacity: 1; width: 9px; height: 9px; border-radius: 50%; background: #fff; transform: scale(1); }
.drc-f-opt.cb.sel .drc-f-ind::after { opacity: 1; width: 6px; height: 11px; border: solid #fff; border-width: 0 2.5px 2.5px 0; transform: rotate(43deg) translate(-1px, -1px); }
.drc-f-lbl { flex: 1; }
.drc-f-checkmark { flex-shrink: 0; color: #1E9E3A; font-weight: 800; font-size: 13px; opacity: 0; transform: translateX(-4px); transition: opacity 0.16s, transform 0.16s; }
.drc-f-opt.sel .drc-f-checkmark { opacity: 1; transform: translateX(0); }

/* Texto */
.drc-f-txt {
  width: 100%; max-width: 560px; padding: 15px 17px; border-radius: 14px;
  border: 1.5px solid #E4E4DD; background: #fff; font-family: inherit; font-size: 16px; color: #191A17;
  box-shadow: 0 1px 2px rgba(20, 30, 15, 0.05); transition: border-color 0.16s, box-shadow 0.16s;
}
.drc-f-txt:hover { border-color: #D2D2CA; }
.drc-f-txt:focus { outline: none; border-color: #1E9E3A; box-shadow: 0 0 0 3px rgba(255, 196, 0, 0.4); }
.drc-f-area { min-height: 140px; resize: vertical; line-height: 1.5; }

/* Matriz */
.drc-f-matrix { display: flex; flex-direction: column; gap: 14px; }
.drc-f-mrow { display: grid; grid-template-columns: 130px 1fr; align-items: center; gap: 16px; }
.drc-f-mlabel { font-size: 15.5px; font-weight: 700; color: #191A17; display: flex; align-items: center; gap: 9px; }
.drc-f-mi { font-size: 17px; }
.drc-f-levels { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
.drc-f-lvl {
  appearance: none; border: 1.5px solid #E4E4DD; background: #fff; border-radius: 10px;
  padding: 11px 6px; min-height: 50px; font-family: inherit; font-size: 12.5px; font-weight: 600;
  line-height: 1.2; color: #46473F; cursor: pointer; box-shadow: 0 1px 2px rgba(20, 30, 15, 0.05);
  transition: border-color 0.16s, background 0.16s, color 0.16s, transform 0.14s, box-shadow 0.16s;
}
.drc-f-lvl:hover { border-color: #1E9E3A; background: rgba(30, 158, 58, 0.08); color: #167a2d; transform: translateY(-1px); }
.drc-f-lvl:focus-visible { outline: none; border-color: #1E9E3A; box-shadow: 0 0 0 3px rgba(255, 196, 0, 0.55); }
.drc-f-lvl.sel { background: #1E9E3A; border-color: #1E9E3A; color: #fff; font-weight: 700; box-shadow: 0 4px 12px rgba(30, 158, 58, 0.32); }

/* Error */
.drc-f-err {
  margin-top: 18px; padding: 12px 15px; border-radius: 11px;
  background: rgba(192, 57, 43, 0.08); border: 1px solid rgba(192, 57, 43, 0.35);
  color: #C0392B; font-size: 14px; font-weight: 600;
  display: flex; align-items: center; gap: 8px; max-width: 640px;
  animation: drc-f-shake 0.3s;
}
@keyframes drc-f-shake { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }

/* Nav */
.drc-f-nav {
  display: flex; gap: 12px; align-items: center; justify-content: space-between;
  padding: 18px 40px; border-top: 1px solid #E4E4DD; background: #fff;
}
.drc-f-nav.start { justify-content: flex-start; }
.drc-f-btn {
  appearance: none; font-family: inherit; font-weight: 700; border-radius: 12px; cursor: pointer;
  padding: 13px 26px; font-size: 15px; min-height: 50px;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  transition: transform 0.14s, box-shadow 0.16s, background 0.16s, border-color 0.16s;
}
.drc-f-btn-ghost { background: transparent; border: 1.5px solid #D2D2CA; color: #46473F; }
.drc-f-btn-ghost:hover { border-color: #83847A; background: #FBFBF9; }
.drc-f-btn-ghost:disabled { opacity: 0.4; cursor: not-allowed; }
.drc-f-btn-primary { background: #1E9E3A; border: 1.5px solid #1E9E3A; color: #fff; box-shadow: 0 6px 16px rgba(30, 158, 58, 0.28); }
.drc-f-btn-primary:hover { background: #167a2d; transform: translateY(-1px); box-shadow: 0 10px 22px rgba(30, 158, 58, 0.36); }
.drc-f-btn-primary:disabled { opacity: 0.7; cursor: wait; }
.drc-f-btn:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(255, 196, 0, 0.6); }

/* Pantallas (bienvenida / gracias / error) */
.drc-f-screen { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.drc-f-screen.center { align-items: center; text-align: center; }
.drc-f-big { font-size: 54px; line-height: 1; margin-bottom: 6px; }
.drc-f-screen h1 { margin: 0 0 12px; font-size: clamp(25px, 3vw, 34px); font-weight: 800; letter-spacing: -0.5px; }
.drc-f-screen p { margin: 0 0 12px; font-size: 16.5px; color: #46473F; max-width: 54ch; line-height: 1.6; }
.drc-f-screen p.drc-f-muted { color: #83847A; }
.drc-f-sig { color: #167a2d; font-weight: 700; margin-top: 4px; }

/* CTA del test de nivel (pantalla final del formulario) */
.drc-f-cta {
  width: 100%; max-width: 520px; margin: 22px auto 8px; text-align: center;
  background: linear-gradient(180deg, rgba(30, 158, 58, 0.07), rgba(255, 196, 0, 0.05));
  border: 1.5px solid rgba(30, 158, 58, 0.28); border-radius: 18px; padding: 26px 24px;
}
.drc-f-cta-badge {
  display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 800;
  text-transform: uppercase; letter-spacing: 0.07em; color: #167a2d;
  background: rgba(30, 158, 58, 0.12); padding: 6px 13px; border-radius: 999px; margin-bottom: 12px;
}
.drc-f-cta-title { font-size: 21px; font-weight: 800; color: #191A17; letter-spacing: -0.4px; margin-bottom: 8px; }
.drc-f-cta-text { font-size: 15px; color: #46473F; line-height: 1.6; margin: 0 auto 20px; max-width: 44ch; }
.drc-f-cta-btn { width: 100%; max-width: 340px; text-decoration: none; }
.drc-f-cta-note { font-size: 12.5px; color: #83847A; margin-top: 12px; line-height: 1.5; }
.drc-f-chip {
  display: inline-flex; align-items: center; gap: 7px; background: rgba(30, 158, 58, 0.08);
  color: #167a2d; font-size: 13px; font-weight: 700; padding: 7px 14px; border-radius: 999px;
}
.drc-f-screen .drc-f-chip { margin-bottom: 22px; }

/* Spinner */
.drc-f-spin { display: flex; flex-direction: column; align-items: center; gap: 14px; }
.drc-f-spin .ring { width: 34px; height: 34px; border: 3px solid #E4E4DD; border-top-color: #1E9E3A; border-radius: 50%; animation: drc-f-rot 0.8s linear infinite; }
.drc-f-spin .txt { font-size: 14px; color: #83847A; }
@keyframes drc-f-rot { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .drc-f-anim, .drc-f-err, .drc-f-spin .ring { animation: none; }
  .drc-f-fill { transition: none; }
}

/* ─── Desktop (≥1024): aprovechar el ancho ─── */
@media (min-width: 1024px) {
  .drc-f-head { padding: 22px 44px 20px; }
  .drc-f-content { padding: 44px 52px; }
  .drc-f-nav { padding: 20px 52px; }
  .drc-f-opts { max-width: 720px; }
  .drc-f-opts.two { display: grid; grid-template-columns: 1fr 1fr; max-width: 760px; }
}

/* ─── Mobile (<768): full-bleed + nav anclada abajo ─── */
@media (max-width: 767px) {
  .drc-f-page { padding: 0; align-items: stretch; }
  .drc-f-stage { max-width: none; }
  .drc-f-card { border-radius: 0; border: 0; box-shadow: none; min-height: 100dvh; }
  .drc-f-head { padding: 15px 18px 14px; gap: 11px; padding-top: max(15px, env(safe-area-inset-top)); }
  .drc-f-logo { width: 34px; height: 34px; font-size: 12.5px; }
  .drc-f-bsub { display: none; }
  .drc-f-pct { font-size: 15px; }
  .drc-f-content { padding: 22px 18px; flex: 1; }
  .drc-f-title { font-size: 21px; max-width: none; }
  .drc-f-hint { font-size: 14.5px; margin-bottom: 20px; }
  .drc-f-opts, .drc-f-txt, .drc-f-err { max-width: none; }
  .drc-f-mrow { grid-template-columns: 1fr; gap: 8px; }
  .drc-f-lvl { font-size: 10.5px; padding: 9px 3px; min-height: 52px; }
  .drc-f-nav {
    position: sticky; bottom: 0; padding: 12px 18px;
    padding-bottom: max(12px, env(safe-area-inset-bottom));
    box-shadow: 0 -6px 18px rgba(0, 0, 0, 0.05);
  }
  .drc-f-btn { flex: 1; padding: 13px 12px; }
  .drc-f-btn-ghost { flex: 0 0 auto; padding: 13px 18px; }
  .drc-f-footer { display: none; }
}
`;
