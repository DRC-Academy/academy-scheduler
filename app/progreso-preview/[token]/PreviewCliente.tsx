'use client';

// La vista previa del rediseño: MISMA carga de datos que /progreso/[token]
// (copiada de app/progreso/[token]/page.tsx, mismas consultas y mismas reglas),
// montando la ficha nueva (components/ProgresoFichaV2).
//
// La franja de arriba y el selector «Vista web / Vista Mi cuenta» son SOLO de
// esta página: no forman parte de la ficha, así que al aprobar el diseño no hay
// nada que limpiar. «Vista Mi cuenta» imita el iframe de /progreso-cuenta: sin
// cabecera, a ancho completo y sin márgenes laterales.

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { ProgresoFichaV2, ProgresoV2Styles } from '@/components/ProgresoFichaV2';
import { DiplomaV2FromToken } from '@/components/DiplomaBannerV2';
import {
  PROFILE_COLS, PROFILE_COLS_EXTRA, ANALYSIS_COLS, ASSIGNMENT_COLS, STUDENT_COLS,
  isMissingColumnError, pickAssignment, earliestStartDate, type AssignmentLite, type StudentLite,
} from '@/lib/progresoData';
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
  | { kind: 'ready'; row: TokenRow; profile: StudentProfileRow | null; analyses: ClassAnalysisRow[]; assignment: AssignmentLite | null; startDate: string | null; student: StudentLite | null };

type Vista = 'web' | 'cuenta';

export function PreviewCliente({ token }: { token: string }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [vista, setVista] = useState<Vista>('web');

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

      const profileQ = (cols: string) => (row.student_id
        ? supabase.from('student_profiles').select(cols).eq('student_id', row.student_id).limit(1)
        : supabase.from('student_profiles').select(cols).ilike('student_name', row.student_name).limit(1));
      const analysesQ = row.student_id
        ? supabase.from('class_analyses').select(ANALYSIS_COLS).eq('student_id', row.student_id).order('analyzed_at', { ascending: false })
        : supabase.from('class_analyses').select(ANALYSIS_COLS).ilike('student_name', row.student_name).order('analyzed_at', { ascending: false });
      const assignQ = row.student_id
        ? supabase.from('assignments').select(ASSIGNMENT_COLS).eq('student_id', row.student_id)
        : supabase.from('assignments').select(ASSIGNMENT_COLS).ilike('student_name', row.student_name);
      const studentQ = row.student_id
        ? supabase.from('students').select(STUDENT_COLS).eq('id', row.student_id).limit(1)
        : null;

      const [firstP, aRes, asgRes, stRes] = await Promise.all([
        profileQ(PROFILE_COLS_EXTRA), analysesQ, assignQ, studentQ ?? Promise.resolve({ data: null }),
      ]);
      const pRes = isMissingColumnError(firstP.error) ? await profileQ(PROFILE_COLS) : firstP;
      if (cancelled) return;
      const assignments = (asgRes.data ?? []) as unknown as AssignmentLite[];
      setState({
        kind: 'ready',
        row,
        profile: (pRes.data?.[0] ?? null) as unknown as StudentProfileRow | null,
        analyses: (aRes.data ?? []) as unknown as ClassAnalysisRow[],
        assignment: pickAssignment(assignments),
        startDate: earliestStartDate(assignments),
        student: ((stRes as { data: unknown[] | null }).data?.[0] ?? null) as StudentLite | null,
      });
    })();
    return () => { cancelled = true; };
  }, [token]);

  const cuenta = vista === 'cuenta';

  return (
    <div className={`p2-page${cuenta ? ' p2-embed' : ''}`}>
      <ProgresoV2Styles />
      <style>{PREVIEW_CSS}</style>

      <div className="pv-franja">
        <p className="pv-franja-txt">Vista previa del rediseño — no visible para alumnos</p>
        <div className="pv-vistas" role="group" aria-label="Cómo se ve">
          <button type="button" aria-pressed={!cuenta} className={!cuenta ? 'is-on' : ''} onClick={() => setVista('web')}>Vista web</button>
          <button type="button" aria-pressed={cuenta} className={cuenta ? 'is-on' : ''} onClick={() => setVista('cuenta')}>Vista Mi cuenta</button>
        </div>
      </div>

      {!cuenta && (
        <>
          <div className="pv-topline" aria-hidden />
          <header className="pv-header">
            <div className="pv-header-in">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/drc-logo.png" alt="DRC Academy" className="pv-logo" />
            </div>
          </header>
        </>
      )}

      <main className="pv-main">
        {state.kind === 'loading' && <div className="pv-aviso" role="status">Cargando tu progreso…</div>}
        {state.kind === 'invalid' && (
          <div className="pv-aviso"><strong>Este enlace no es válido.</strong><span>Pídele a tu profesor que te comparta uno nuevo.</span></div>
        )}
        {state.kind === 'expired' && (
          <div className="pv-aviso"><strong>Este enlace ha caducado.</strong><span>Pídele a tu profesor que te comparta uno nuevo.</span></div>
        )}
        {state.kind === 'ready' && (
          <ProgresoFichaV2
            studentName={state.row.student_name}
            profile={state.profile}
            analyses={state.analyses}
            assignment={state.assignment}
            student={state.student}
            diplomaSlot={<DiplomaV2FromToken token={state.row.student_id ? token : null} startDate={state.startDate} />}
          />
        )}
      </main>
    </div>
  );
}

const PREVIEW_CSS = `
.pv-franja {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  padding: 8px 16px; background: #191A17; color: #FFFFFF;
}
.pv-franja-txt { margin: 0; font-size: 13px; font-weight: 600; line-height: 18px; }
.pv-vistas { display: flex; gap: 2px; padding: 2px; border-radius: 999px; background: rgba(255,255,255,0.12); }
.pv-vistas button {
  min-height: 32px; padding: 6px 12px; border: 0; border-radius: 999px; background: transparent;
  color: #FFFFFF; font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.pv-vistas button.is-on { background: #FFFFFF; color: #191A17; }
.pv-vistas button:focus-visible { outline: 2px solid #FFC400; outline-offset: 2px; }

.pv-topline { height: 4px; background: linear-gradient(90deg, #1E9E3A 0%, #1E9E3A 58%, #FFC400 100%); }
.pv-header { background: #FFFFFF; border-bottom: 1px solid #E2E3DC; }
.pv-header-in { max-width: 920px; margin: 0 auto; padding: 14px 20px; }
.pv-logo { height: 30px; width: auto; display: block; }

.pv-main { max-width: 920px; margin: 0 auto; padding: 40px 20px 72px; }
/* Como el iframe de Mi cuenta: sin ancho máximo ni márgenes laterales. */
.p2-embed { min-height: 0; }
.p2-embed .pv-main { max-width: none; margin: 0; padding: 0 0 28px; }

.pv-aviso {
  background: #FFFFFF; border: 1px solid #E2E3DC; border-radius: 18px; padding: 46px 26px;
  text-align: center; color: #5A5E56; font-size: 15px; line-height: 1.7; display: flex; flex-direction: column; gap: 4px;
}
.pv-aviso strong { color: #191A17; font-size: 16.5px; }

@media (max-width: 720px) {
  .pv-main { padding: 22px 16px 56px; }
  .pv-header-in { padding: 12px 16px; }
  .pv-logo { height: 26px; }
}
`;
