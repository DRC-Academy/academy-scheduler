'use client';

// Página PÚBLICA del formulario inicial del alumno (link único).
// No requiere login. Diseño mobile-first con branding DRC.

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { FORM_QUESTIONS, firstUnansweredRequired, type FormResponses, type FormQuestion } from '@/lib/formQuestions';

// ── Branding DRC ──────────────────────────────────────────────────────────────
const GREEN = '#1E9E3A';
const GREEN_DARK = '#167a2d';
const YELLOW = '#FFC400';
const BG = '#F7F7F5';
const SURFACE = '#FFFFFF';
const BORDER = '#E0E0DA';
const TEXT = '#1A1A1A';
const TEXT_MUTED = '#6b6b64';
const FONT = "'Radio Canada', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

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

  if (state.kind === 'loading') return <Centered><Spinner /></Centered>;
  if (state.kind === 'invalid') return <ErrorScreen />;
  if (state.kind === 'done') return <AlreadyDoneScreen />;
  return <FormFlow token={state.token} />;
}

// ── Flujo del formulario (una pregunta a la vez) ────────────────────────────────
function FormFlow({ token }: { token: TokenRow }) {
  const total = FORM_QUESTIONS.length;
  const [step, setStep] = useState(-1);   // -1 = pantalla de bienvenida
  const [responses, setResponses] = useState<FormResponses>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const q = step >= 0 && step < total ? FORM_QUESTIONS[step] : null;

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
    const missing = firstUnansweredRequired(responses);
    if (missing) {
      setError(`Falta responder: ${missing.title}`);
      const idx = FORM_QUESTIONS.findIndex(x => x.id === missing.id);
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
        setError(data?.error || 'No se pudieron enviar tus respuestas. Intentá de nuevo.');
        setSubmitting(false);
        return;
      }
      setSent(true);
    } catch {
      setError('No hay conexión. Revisá tu internet e intentá de nuevo.');
      setSubmitting(false);
    }
  }

  if (sent) return <ThankYouScreen studentName={token.student_name} teacherName={token.teacher_name} />;

  return (
    <Page>
      <Header />
      <div style={{ padding: '0 20px 120px' }}>
        {step === -1 ? (
          <WelcomeScreen token={token} onStart={() => setStep(0)} />
        ) : step >= total ? (
          <ReviewScreen submitting={submitting} onSubmit={submit} onBack={() => setStep(total - 1)} />
        ) : (
          <>
            <ProgressBar current={step + 1} total={total} />
            {q && (
              <QuestionCard
                question={q}
                value={responses[q.id]}
                onChange={v => setAnswer(q.id, v)}
              />
            )}
          </>
        )}

        {error && (
          <div style={{ marginTop: 16, padding: '11px 14px', borderRadius: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.4)', color: '#b91c1c', fontSize: 14, fontWeight: 600 }}>
            {error}
          </div>
        )}
      </div>

      {/* Navegación fija abajo (sólo dentro de las preguntas) */}
      {step >= 0 && step < total && (
        <StickyNav>
          <button onClick={prev} style={navBtnSecondary}>← Anterior</button>
          <button onClick={next} style={navBtnPrimary}>
            {step === total - 1 ? 'Revisar ✓' : 'Siguiente →'}
          </button>
        </StickyNav>
      )}
      <Footer />
    </Page>
  );
}

// ── Pantallas ───────────────────────────────────────────────────────────────
function WelcomeScreen({ token, onStart }: { token: TokenRow; onStart: () => void }) {
  return (
    <div style={{ paddingTop: 26 }}>
      <h1 style={{ fontSize: 26, fontWeight: 800, color: TEXT, margin: '0 0 14px', lineHeight: 1.25 }}>
        ¡Hola, {token.student_name}! 👋
      </h1>
      <p style={{ fontSize: 16, color: TEXT, lineHeight: 1.6, margin: '0 0 12px' }}>
        Antes de tu primera clase con <b>{token.teacher_name}</b>, quiero conocerte un poco mejor.
      </p>
      <p style={{ fontSize: 16, color: TEXT, lineHeight: 1.6, margin: '0 0 12px' }}>
        Estas preguntas me ayudan a preparar una clase 100% tuya desde el minuto uno.
      </p>
      <p style={{ fontSize: 16, color: TEXT_MUTED, lineHeight: 1.6, margin: '0 0 26px' }}>
        Son solo 10 minutos — ¡vale la pena! 😊
      </p>
      <button onClick={onStart} style={{ ...navBtnPrimary, width: '100%', padding: '15px', fontSize: 16 }}>
        Empezar →
      </button>
    </div>
  );
}

function ReviewScreen({ submitting, onSubmit, onBack }: { submitting: boolean; onSubmit: () => void; onBack: () => void }) {
  return (
    <div style={{ paddingTop: 26 }}>
      <div style={{ fontSize: 44, marginBottom: 8 }}>🎉</div>
      <h2 style={{ fontSize: 22, fontWeight: 800, color: TEXT, margin: '0 0 12px' }}>¡Ya está!</h2>
      <p style={{ fontSize: 16, color: TEXT, lineHeight: 1.6, margin: '0 0 26px' }}>
        Respondiste todas las preguntas. Cuando quieras, enviá tus respuestas.
      </p>
      <button onClick={onSubmit} disabled={submitting}
        style={{ ...navBtnPrimary, width: '100%', padding: '15px', fontSize: 16, opacity: submitting ? 0.7 : 1, cursor: submitting ? 'wait' : 'pointer' }}>
        {submitting ? 'Enviando…' : 'Enviar respuestas ✨'}
      </button>
      <button onClick={onBack} disabled={submitting} style={{ ...navBtnSecondary, width: '100%', marginTop: 12 }}>
        ← Volver a revisar
      </button>
    </div>
  );
}

function ThankYouScreen({ studentName, teacherName }: { studentName: string; teacherName: string }) {
  return (
    <Page>
      <Header />
      <div style={{ padding: '40px 24px', textAlign: 'center', maxWidth: 600, margin: '0 auto' }}>
        <div style={{ fontSize: 56, marginBottom: 12 }}>🎉</div>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: TEXT, margin: '0 0 16px' }}>
          ¡Gracias, {studentName}!
        </h1>
        <p style={{ fontSize: 17, color: TEXT, lineHeight: 1.6, margin: '0 0 8px' }}>
          Ya estoy preparando tu primera clase.
        </p>
        <p style={{ fontSize: 17, color: TEXT, lineHeight: 1.6, margin: '0 0 24px' }}>
          Nos vemos pronto 😊
        </p>
        <p style={{ fontSize: 16, color: GREEN, fontWeight: 700 }}>— {teacherName}</p>
      </div>
      <Footer />
    </Page>
  );
}

function ErrorScreen() {
  return (
    <Page>
      <Header />
      <div style={{ padding: '48px 24px', textAlign: 'center', maxWidth: 600, margin: '0 auto' }}>
        <div style={{ fontSize: 52, marginBottom: 14 }}>🔒</div>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: TEXT, margin: '0 0 14px' }}>
          Este link ya no está disponible
        </h1>
        <p style={{ fontSize: 16, color: TEXT_MUTED, lineHeight: 1.6 }}>
          Contactá a tu profesor para obtener uno nuevo.
        </p>
      </div>
      <Footer />
    </Page>
  );
}

function AlreadyDoneScreen() {
  return (
    <Page>
      <Header />
      <div style={{ padding: '48px 24px', textAlign: 'center', maxWidth: 600, margin: '0 auto' }}>
        <div style={{ fontSize: 52, marginBottom: 14 }}>✅</div>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: TEXT, margin: '0 0 14px' }}>
          ¡Ya completaste este formulario!
        </h1>
        <p style={{ fontSize: 16, color: TEXT_MUTED, lineHeight: 1.6 }}>
          Gracias por tus respuestas. Tu profesor ya las tiene. 😊
        </p>
      </div>
      <Footer />
    </Page>
  );
}

// ── Pregunta ──────────────────────────────────────────────────────────────────
function QuestionCard({ question, value, onChange }: {
  question: FormQuestion;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  return (
    <div style={{ paddingTop: 22 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: GREEN, textTransform: 'none', marginBottom: 10 }}>
        {question.section}
      </div>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: TEXT, lineHeight: 1.35, margin: '0 0 8px' }}>
        {question.title}
        {!question.required && <span style={{ fontSize: 13, fontWeight: 600, color: TEXT_MUTED }}> (opcional)</span>}
      </h2>
      {question.hint && (
        <p style={{ fontSize: 14, color: TEXT_MUTED, lineHeight: 1.55, margin: '0 0 18px' }}>{question.hint}</p>
      )}
      {!question.hint && <div style={{ height: 14 }} />}

      <QuestionInput question={question} value={value} onChange={onChange} />
    </div>
  );
}

function QuestionInput({ question, value, onChange }: {
  question: FormQuestion;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  if (question.type === 'short') {
    return (
      <input
        type="text"
        value={(value as string) ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder="Escribí tu respuesta…"
        autoFocus
        style={textInputStyle}
      />
    );
  }
  if (question.type === 'long') {
    return (
      <textarea
        value={(value as string) ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder="Escribí tu respuesta…"
        rows={5}
        autoFocus
        style={{ ...textInputStyle, minHeight: 130, resize: 'vertical', lineHeight: 1.5 }}
      />
    );
  }
  if (question.type === 'radio') {
    const selected = value as string | undefined;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(question.options ?? []).map(opt => (
          <OptionButton key={opt} label={opt} selected={selected === opt} kind="radio"
            onClick={() => onChange(opt)} />
        ))}
      </div>
    );
  }
  if (question.type === 'checkbox') {
    const arr = Array.isArray(value) ? (value as string[]) : [];
    const toggle = (opt: string) => {
      onChange(arr.includes(opt) ? arr.filter(o => o !== opt) : [...arr, opt]);
    };
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(question.options ?? []).map(opt => (
          <OptionButton key={opt} label={opt} selected={arr.includes(opt)} kind="checkbox"
            onClick={() => toggle(opt)} />
        ))}
      </div>
    );
  }
  if (question.type === 'matrix') {
    const obj = (value ?? {}) as Record<string, string>;
    const setRow = (row: string, col: string) => onChange({ ...obj, [row]: col });
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {(question.rows ?? []).map(row => (
          <div key={row}>
            <div style={{ fontSize: 15, fontWeight: 700, color: TEXT, marginBottom: 8 }}>{row}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {(question.cols ?? []).map(col => (
                <button key={col} onClick={() => setRow(row, col)} type="button"
                  style={{
                    flex: '1 1 auto', minWidth: 92, minHeight: 44, padding: '8px 10px', borderRadius: 10,
                    fontFamily: FONT, fontSize: 14, cursor: 'pointer',
                    border: `1.5px solid ${obj[row] === col ? GREEN : BORDER}`,
                    background: obj[row] === col ? 'rgba(30,158,58,0.1)' : SURFACE,
                    color: obj[row] === col ? GREEN_DARK : TEXT, fontWeight: obj[row] === col ? 700 : 500,
                  }}>
                  {col}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }
  return null;
}

function OptionButton({ label, selected, kind, onClick }: {
  label: string; selected: boolean; kind: 'radio' | 'checkbox'; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
        padding: '14px 16px', borderRadius: 12, cursor: 'pointer', fontFamily: FONT, fontSize: 16,
        minHeight: 52, lineHeight: 1.35,
        border: `1.5px solid ${selected ? GREEN : BORDER}`,
        background: selected ? 'rgba(30,158,58,0.08)' : SURFACE,
        color: TEXT, fontWeight: selected ? 600 : 500,
      }}>
      <span style={{ fontSize: 18, flexShrink: 0 }}>
        {kind === 'radio' ? (selected ? '🔘' : '⚪') : (selected ? '☑️' : '⬜')}
      </span>
      <span>{label}</span>
    </button>
  );
}

// ── Layout / chrome ─────────────────────────────────────────────────────────
function Page({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100dvh', background: BG, fontFamily: FONT, color: TEXT }}>
      <div style={{ maxWidth: 600, margin: '0 auto' }}>{children}</div>
    </div>
  );
}

function Header() {
  return (
    <div style={{ background: GREEN, padding: '22px 20px', textAlign: 'center' }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10, background: 'white',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 900, fontSize: 18, color: GREEN, letterSpacing: -0.5,
        }}>DRC</div>
        <div style={{ textAlign: 'left' }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: 'white', lineHeight: 1.1 }}>DRC Academy</div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)' }}>Formulario inicial</div>
        </div>
      </div>
      <div style={{ height: 3, width: 48, background: YELLOW, borderRadius: 2, margin: '14px auto 0' }} />
    </div>
  );
}

function ProgressBar({ current, total }: { current: number; total: number }) {
  const pct = Math.round((current / total) * 100);
  return (
    <div style={{ paddingTop: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: TEXT_MUTED }}>Pregunta {current} de {total}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: GREEN }}>{pct}%</span>
      </div>
      <div style={{ height: 8, background: '#E8E8E4', borderRadius: 6, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: GREEN, borderRadius: 6, transition: 'width 0.3s ease' }} />
      </div>
    </div>
  );
}

function StickyNav({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, background: SURFACE,
      borderTop: `1px solid ${BORDER}`, padding: '12px 20px',
      paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
    }}>
      <div style={{ maxWidth: 600, margin: '0 auto', display: 'flex', gap: 12 }}>{children}</div>
    </div>
  );
}

function Footer() {
  return (
    <div style={{ padding: '20px', textAlign: 'center', fontSize: 12, color: TEXT_MUTED }}>
      DRC Academy — Plataforma de gestión interna
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100dvh', background: BG, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT }}>
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
      <div style={{ width: 34, height: 34, border: `3px solid ${BORDER}`, borderTopColor: GREEN, borderRadius: '50%', animation: 'drc-spin 0.8s linear infinite' }} />
      <div style={{ fontSize: 14, color: TEXT_MUTED }}>Cargando…</div>
      <style>{`@keyframes drc-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── Estilos compartidos ───────────────────────────────────────────────────────
const textInputStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '14px 16px', borderRadius: 12,
  border: `1.5px solid ${BORDER}`, background: SURFACE, color: TEXT,
  fontSize: 16, fontFamily: FONT, minHeight: 52, outline: 'none',
};

const navBtnPrimary: CSSProperties = {
  flex: 2, padding: '13px', borderRadius: 10, border: 'none', background: GREEN,
  color: 'white', fontSize: 15, fontWeight: 800, fontFamily: FONT, cursor: 'pointer', minHeight: 48,
};

const navBtnSecondary: CSSProperties = {
  flex: 1, padding: '13px', borderRadius: 10, border: `1.5px solid ${BORDER}`,
  background: SURFACE, color: TEXT_MUTED, fontSize: 15, fontWeight: 600, fontFamily: FONT, cursor: 'pointer', minHeight: 48,
};
