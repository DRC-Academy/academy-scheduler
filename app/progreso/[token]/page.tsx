'use client';

// Página PÚBLICA de progreso del alumno (link único, sin login).
//
// Deliberadamente NO muestra datos internos: nada de errores detectados, notas
// para el profesor, transcripciones ni señal de riesgo con su etiqueta cruda.
// Solo objetivo, puntos fuertes, foco actual y el resumen de cada clase.

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { BulletList, toBullets } from '@/components/alumnos/studentPageUi';
import type { ClassAnalysisRow, StudentProfileRow } from '@/lib/aiTypes';

interface TokenRow {
  token: string;
  student_id: string | null;
  student_name: string;
  expires_at: string | null;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'ready'; row: TokenRow; profile: StudentProfileRow | null; analyses: ClassAnalysisRow[] };

const PROFILE_COLS = 'id, student_id, student_name, strong_points, personal_objective, recommended_focus, total_classes_analyzed';
const ANALYSIS_COLS = 'id, student_id, student_name, class_number, class_summary, class_title, analyzed_at, class_date';

export default function ProgresoPage() {
  const params = useParams<{ token: string }>();
  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows } = await supabase
        .from('progress_tokens')
        .select('token, student_id, student_name, expires_at')
        .eq('token', token)
        .limit(1);

      const row = (rows?.[0] ?? null) as TokenRow | null;
      if (!row) { if (!cancelled) setState({ kind: 'invalid' }); return; }
      if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
        if (!cancelled) setState({ kind: 'expired' });
        return;
      }

      // La ficha y las clases se buscan por student_id y, como respaldo, por
      // nombre — el mismo criterio tolerante que usa el resto del sistema.
      const profileQ = row.student_id
        ? supabase.from('student_profiles').select(PROFILE_COLS).eq('student_id', row.student_id).limit(1)
        : supabase.from('student_profiles').select(PROFILE_COLS).ilike('student_name', row.student_name).limit(1);
      const analysesQ = row.student_id
        ? supabase.from('class_analyses').select(ANALYSIS_COLS).eq('student_id', row.student_id).order('analyzed_at', { ascending: false })
        : supabase.from('class_analyses').select(ANALYSIS_COLS).ilike('student_name', row.student_name).order('analyzed_at', { ascending: false });

      const [pRes, aRes] = await Promise.all([profileQ, analysesQ]);
      if (cancelled) return;
      setState({
        kind: 'ready',
        row,
        profile: (pRes.data?.[0] ?? null) as unknown as StudentProfileRow | null,
        analyses: (aRes.data ?? []) as unknown as ClassAnalysisRow[],
      });
    })();
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div style={{ minHeight: '100vh', background: '#F7F7F5' }}>
      <header style={{ background: '#fff', borderBottom: '1px solid #e6e7e2', padding: '14px 16px' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/drc-logo.png" alt="DRC Academy" style={{ height: 30, width: 'auto', objectFit: 'contain' }} />
        </div>
      </header>

      <div className="sp" style={{ maxWidth: 760 }}>
        {state.kind === 'loading' && <div className="sp-empty">Cargando tu progreso…</div>}

        {state.kind === 'invalid' && (
          <div className="sp-card sp-empty">
            Este link no es válido. Pedile a tu profesor que te comparta uno nuevo.
          </div>
        )}

        {state.kind === 'expired' && (
          <div className="sp-card sp-empty">
            Este link ya expiró. Pedile a tu profesor que te comparta uno nuevo.
          </div>
        )}

        {state.kind === 'ready' && (
          <Progress row={state.row} profile={state.profile} analyses={state.analyses} />
        )}
      </div>
    </div>
  );
}

function Progress({ row, profile, analyses }: {
  row: TokenRow;
  profile: StudentProfileRow | null;
  analyses: ClassAnalysisRow[];
}) {
  const strong = toBullets(profile?.strong_points);

  return (
    <>
      <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.015em', margin: '4px 0 4px' }}>
        Tu progreso en inglés con DRC Academy
      </h1>
      <div style={{ fontSize: 15, color: 'var(--sp-t2)', marginBottom: 22 }}>{row.student_name}</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {profile?.personal_objective && (
          <div className="sp-card sp-objective">
            <div className="sp-card-title">Tu objetivo</div>
            <div className="sp-body">{profile.personal_objective}</div>
          </div>
        )}

        {strong.length > 0 && (
          <div className="sp-card">
            <div className="sp-card-title">Tus puntos fuertes</div>
            <BulletList items={strong} />
          </div>
        )}

        {profile?.recommended_focus && (
          <div className="sp-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
              <span className="sp-card-title" style={{ marginBottom: 0 }}>En qué estamos trabajando</span>
              <span className="sp-badge-yellow">Foco actual</span>
            </div>
            <div className="sp-body">{profile.recommended_focus}</div>
          </div>
        )}

        <div>
          <div className="sp-card-title" style={{ marginBottom: 12 }}>Tu progreso clase a clase</div>
          {analyses.length === 0 ? (
            <div className="sp-card sp-empty" style={{ padding: '28px 20px' }}>
              Todavía no hay clases registradas. ¡Esto se irá llenando a medida que avances!
            </div>
          ) : (
            <div className="sp-feed">
              {analyses.map(r => (
                <div key={r.id} className="sp-card">
                  <div className="sp-feed-head">
                    <div className="sp-feed-title">
                      Clase {r.class_number ?? '—'}
                      <span className="sp-feed-date">
                        {' · '}
                        {new Date(r.class_date ?? r.analyzed_at).toLocaleDateString('es-ES', {
                          day: 'numeric', month: 'long', year: 'numeric',
                        })}
                      </span>
                    </div>
                  </div>
                  {r.class_title && (
                    <div style={{ fontSize: 13.5, color: 'var(--sp-t2)', marginTop: 4 }}>{r.class_title}</div>
                  )}
                  {r.class_summary && (
                    <div className="sp-body" style={{ marginTop: 10 }}>{r.class_summary}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 28, fontSize: 12.5, color: 'var(--sp-t3)', textAlign: 'center', lineHeight: 1.6 }}>
        Este resumen es privado y solo para vos. Si tenés dudas, hablalo con tu profesor.
      </div>
    </>
  );
}
