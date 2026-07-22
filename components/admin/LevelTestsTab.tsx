'use client';

// Panel admin: listado de Tests de Nivel generados + generar link + detalle.
// Lee las sesiones/respuestas con la clave anónima (RLS off, igual que el resto).

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  fetchLevelTestIndex, generateTestLink, buildTestUrl, testStateOf,
  type LevelTestInfo, type LTState,
} from '@/lib/levelTestClient';
import type { WritingEvaluation } from '@/lib/levelTest/types';
import { CEFR_COLOR } from '@/lib/levelTest/constants';

const STATE_META: Record<LTState, { label: string; color: string; bg: string }> = {
  none:        { label: '—',            color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' },
  pending:     { label: 'Pendiente',    color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' },
  in_progress: { label: 'En curso',     color: '#175cd3', bg: 'rgba(37,99,235,0.1)' },
  completed:   { label: 'Completado',   color: '#067647', bg: 'rgba(30,158,58,0.1)' },
  expired:     { label: 'Expirado',     color: '#b42318', bg: 'rgba(239,68,68,0.1)' },
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function LevelTestsTab() {
  const [rows, setRows] = useState<LevelTestInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<'all' | LTState>('all');
  const [cefr, setCefr] = useState<'all' | string>('all');
  const [query, setQuery] = useState('');
  const [showGen, setShowGen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const idx = await fetchLevelTestIndex();
    setRows(idx.all);
    setLoading(false);
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(r => {
      if (status !== 'all' && testStateOf(r) !== status) return false;
      if (cefr !== 'all' && (r.cefr_level || '') !== cefr) return false;
      if (q) {
        const name = (r.student_name || r.candidate_name || '').toLowerCase();
        const email = (r.candidate_email || '').toLowerCase();
        if (!name.includes(q) && !email.includes(q)) return false;
      }
      return true;
    });
  }, [rows, status, cefr, query]);

  const selectStyle = { padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit' } as const;

  return (
    <div>
      {/* Barra superior */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar candidato…"
            style={{ ...selectStyle, minWidth: 200 }} />
          <select value={status} onChange={e => setStatus(e.target.value as typeof status)} style={selectStyle}>
            <option value="all">Todos los estados</option>
            <option value="pending">Pendiente</option>
            <option value="in_progress">En curso</option>
            <option value="completed">Completado</option>
            <option value="expired">Expirado</option>
          </select>
          <select value={cefr} onChange={e => setCefr(e.target.value)} style={selectStyle}>
            <option value="all">Todos los niveles</option>
            {['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <button className="adm-btn adm-btn-primary" onClick={() => setShowGen(true)}>Generar link</button>
      </div>

      {/* Tabla */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 14 }}>Cargando…</div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 14 }}>Sin tests para estos filtros.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--bg-surface-2)', textAlign: 'left' }}>
                  {['Candidato', 'Email', 'Estado', 'Score', 'CEFR', 'Creado', 'Expira', ''].map(h => (
                    <th key={h} style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => {
                  const st = STATE_META[testStateOf(r)];
                  return (
                    <tr key={r.id} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => setDetailId(r.id)}>
                      <td style={{ padding: '10px 14px', color: 'var(--text-primary)', fontWeight: 600, whiteSpace: 'nowrap' }}>{r.student_name || r.candidate_name}</td>
                      <td style={{ padding: '10px 14px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{r.candidate_email || '—'}</td>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                        <span style={{ fontSize: 11, padding: '2px 9px', borderRadius: 12, background: st.bg, color: st.color, fontWeight: 700 }}>{st.label}</span>
                      </td>
                      <td style={{ padding: '10px 14px', color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{r.overall_score != null ? `${Math.round(r.overall_score)}/100` : '—'}</td>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                        {r.cefr_level ? <span style={{ fontWeight: 700, color: CEFR_COLOR[r.cefr_level as keyof typeof CEFR_COLOR] || 'var(--text-primary)' }}>{r.cefr_level}</span> : '—'}
                      </td>
                      <td style={{ padding: '10px 14px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{fmtDate(r.created_at)}</td>
                      <td style={{ padding: '10px 14px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{fmtDate(r.expires_at)}</td>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                        <button onClick={e => { e.stopPropagation(); navigator.clipboard?.writeText(buildTestUrl(r.token)).catch(() => {}); }}
                          style={{ padding: '4px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-surface-2)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>
                          Copiar link
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showGen && <GenerateModal onClose={() => setShowGen(false)} onDone={() => { setShowGen(false); load(); }} />}
      {detailId && <DetailModal id={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}

// ── Modal: generar link ──────────────────────────────────────────────────────
function GenerateModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [days, setDays] = useState(7);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const input = { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' as const, marginBottom: 12 };

  async function gen() {
    if (!name.trim() || !email.trim()) { setErr('Completá nombre y email.'); return; }
    setBusy(true); setErr('');
    try {
      const { url } = await generateTestLink({ candidateName: name.trim(), candidateEmail: email.trim(), candidatePhone: phone.trim(), studentName: name.trim(), expiresInDays: days });
      setUrl(url);
    } catch (e) { setErr(e instanceof Error ? e.message : 'No se pudo generar.'); }
    finally { setBusy(false); }
  }

  return (
    <Overlay onClose={onClose}>
      <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 14 }}>Generar link de test de nivel</div>
      {url ? (
        <>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>Link generado para <b>{name}</b>:</div>
          <div style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', fontSize: 12.5, color: 'var(--text-primary)', wordBreak: 'break-all', marginBottom: 12 }}>{url}</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => navigator.clipboard?.writeText(url).catch(() => {})} className="adm-btn" style={{ flex: 1 }}>Copiar link</button>
            <button onClick={onDone} className="adm-btn adm-btn-primary" style={{ flex: 1 }}>Listo</button>
          </div>
        </>
      ) : (
        <>
          <label style={labelStyle}>Nombre del candidato *</label>
          <input value={name} onChange={e => setName(e.target.value)} style={input} />
          <label style={labelStyle}>Email *</label>
          <input value={email} onChange={e => setEmail(e.target.value)} style={input} type="email" />
          <label style={labelStyle}>Teléfono (opcional)</label>
          <input value={phone} onChange={e => setPhone(e.target.value)} style={input} />
          <label style={labelStyle}>Expira en (días)</label>
          <input value={days} onChange={e => setDays(parseInt(e.target.value) || 7)} style={input} type="number" min={1} />
          {err && <div style={{ fontSize: 12.5, color: '#b42318', marginBottom: 10 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onClose} className="adm-btn" style={{ flex: 1 }}>Cancelar</button>
            <button onClick={gen} disabled={busy} className="adm-btn adm-btn-primary" style={{ flex: 1 }}>{busy ? 'Generando…' : 'Generar'}</button>
          </div>
        </>
      )}
    </Overlay>
  );
}

// ── Modal: detalle de un test ────────────────────────────────────────────────
interface AnswerRow { id: string; section: string; difficulty: number; is_correct: boolean | null; written_response: string | null; ai_score: number | null; ai_feedback: WritingEvaluation | null; }
function DetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [session, setSession] = useState<Record<string, unknown> | null>(null);
  const [answers, setAnswers] = useState<AnswerRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [{ data: s }, { data: a }] = await Promise.all([
        supabase.from('level_test_sessions').select('*').eq('id', id).maybeSingle(),
        supabase.from('level_test_answers').select('id, section, difficulty, is_correct, written_response, ai_score, ai_feedback').eq('session_id', id).order('answered_at', { ascending: true }),
      ]);
      if (!alive) return;
      setSession(s as Record<string, unknown> | null);
      setAnswers((a ?? []) as AnswerRow[]);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [id]);

  const readingCorrect = answers.filter(a => a.section !== 'writing' && a.is_correct).length;
  const readingTotal = answers.filter(a => a.section !== 'writing').length;
  const writing = answers.find(a => a.section === 'writing');
  const ev = writing?.ai_feedback;
  const cefr = session?.cefr_level as string | undefined;

  return (
    <Overlay onClose={onClose} wide>
      {loading ? (
        <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-muted)' }}>Cargando…</div>
      ) : !session ? (
        <div style={{ color: 'var(--text-muted)' }}>No se encontró el test.</div>
      ) : (
        <>
          <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--text-primary)', marginBottom: 2 }}>{(session.student_name as string) || (session.candidate_name as string)}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 14 }}>{session.candidate_email as string}</div>

          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 16 }}>
            <Stat label="Overall" value={session.overall_score != null ? `${Math.round(session.overall_score as number)}/100` : '—'} />
            <Stat label="CEFR" value={cefr ? <span style={{ color: CEFR_COLOR[cefr as keyof typeof CEFR_COLOR] || 'inherit' }}>{cefr}</span> : '—'} />
            <Stat label="Reading" value={session.reading_score != null ? `${Math.round(session.reading_score as number)}/100 (${readingCorrect}/${readingTotal})` : '—'} />
            <Stat label="Writing" value={session.writing_score != null ? `${Math.round(session.writing_score as number)}/100` : '—'} />
          </div>

          {ev && (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>Evaluación de Writing (IA)</div>
              {ev.overall_feedback && <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 8px' }}>{ev.overall_feedback}</p>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px,1fr))', gap: 8, marginBottom: 8 }}>
                {(['grammar', 'vocabulary', 'coherence', 'task_completion'] as const).map(k => (
                  <div key={k} style={{ background: 'var(--bg-surface-2)', borderRadius: 8, padding: '8px 10px' }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'capitalize' }}>{k.replace('_', ' ')}</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{ev[k]?.score}/100</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.4, marginTop: 2 }}>{ev[k]?.feedback}</div>
                  </div>
                ))}
              </div>
              {writing?.written_response && (
                <details style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                  <summary style={{ cursor: 'pointer', color: 'var(--accent)' }}>Ver la respuesta del candidato</summary>
                  <div style={{ whiteSpace: 'pre-wrap', marginTop: 8, background: 'var(--bg-surface-2)', borderRadius: 8, padding: '10px 12px', lineHeight: 1.55 }}>{writing.written_response}</div>
                </details>
              )}
            </div>
          )}

          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Reading: {readingCorrect} de {readingTotal} correctas · Link: <span style={{ wordBreak: 'break-all' }}>{buildTestUrl(session.token as string)}</span>
          </div>
        </>
      )}
    </Overlay>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5 } as const;

function Overlay({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', zIndex: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 22, width: '100%', maxWidth: wide ? 620 : 440, maxHeight: '90vh', overflowY: 'auto' }}>
        {children}
      </div>
    </div>
  );
}
