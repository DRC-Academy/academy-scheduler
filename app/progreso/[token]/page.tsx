'use client';

// Página PÚBLICA de progreso del alumno (link único, sin login).
//
// Es la CÁSCARA: resuelve el token, carga los datos y monta la ficha. El contenido
// vive en components/ProgresoFichaV2 (rediseño del 30/09/2026), que comparte con
// /progreso-cuenta (la misma ficha dentro de "Mi cuenta" de WooCommerce), para
// que no haya dos fichas que se separen en el primer retoque.
//
// Mismo criterio que /test/[token] y /formulario/[token]: sin NavBar, sin
// AuthGuard, con su propia cabecera.

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
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

      // La ficha, las clases y la assignment se buscan por student_id y, como
      // respaldo, por nombre — el mismo criterio tolerante que usa el resto del
      // sistema.
      const profileQ = (cols: string) => (row.student_id
        ? supabase.from('student_profiles').select(cols).eq('student_id', row.student_id).limit(1)
        : supabase.from('student_profiles').select(cols).ilike('student_name', row.student_name).limit(1));
      const analysesQ = row.student_id
        ? supabase.from('class_analyses').select(ANALYSIS_COLS).eq('student_id', row.student_id).order('analyzed_at', { ascending: false })
        : supabase.from('class_analyses').select(ANALYSIS_COLS).ilike('student_name', row.student_name).order('analyzed_at', { ascending: false });
      const assignQ = row.student_id
        ? supabase.from('assignments').select(ASSIGNMENT_COLS).eq('student_id', row.student_id)
        : supabase.from('assignments').select(ASSIGNMENT_COLS).ilike('student_name', row.student_name);

      // La fila de `students` solo se puede pedir con el id; sin el (tokens
      // viejos que solo guardaron el nombre) la meta se detecta con los textos de
      // la assignment, como antes.
      const studentQ = row.student_id
        ? supabase.from('students').select(STUDENT_COLS).eq('id', row.student_id).limit(1)
        : null;

      const [firstP, aRes, asgRes, stRes] = await Promise.all([
        profileQ(PROFILE_COLS_EXTRA), analysesQ, assignQ, studentQ ?? Promise.resolve({ data: null }),
      ]);
      // 42703 / PGRST204 = supabase-teacher-level.sql sin correr. Se reintenta
      // sin esa columna: el alumno ve su progreso igual, con el nivel de antes.
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

  return (
    <div className="p2-page">
      <ProgresoV2Styles />
      <div className="p2-topline" aria-hidden />

      <header className="p2-header">
        <div className="p2-header-in">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/drc-logo.png" alt="DRC Academy" className="p2-logo" />
        </div>
      </header>

      <main className="p2-main">
        {state.kind === 'loading' && (
          <div className="p2-aviso" role="status">Cargando tu progreso…</div>
        )}

        {state.kind === 'invalid' && (
          <div className="p2-aviso">
            <strong>Este enlace no es válido.</strong>
            <span>Pídele a tu profesor que te comparta uno nuevo.</span>
          </div>
        )}

        {state.kind === 'expired' && (
          <div className="p2-aviso">
            <strong>Este enlace ha caducado.</strong>
            <span>Pídele a tu profesor que te comparta uno nuevo.</span>
          </div>
        )}

        {state.kind === 'ready' && (
          <ProgresoFichaV2
            studentName={state.row.student_name}
            profile={state.profile}
            analyses={state.analyses}
            assignment={state.assignment}
            student={state.student}
            // El banner del diploma se pinta ya con la fecha de inicio; si el
            // LMS dice "conseguido" lo pide el navegador a /api/progreso/diploma con
            // este mismo token (el secreto del LMS se queda en el servidor) y llega
            // después, sin frenar la ficha. Los tokens viejos que solo guardaron el
            // nombre no tienen cruce posible con el LMS: cuenta por fecha y ya.
            diplomaSlot={<DiplomaV2FromToken token={state.row.student_id ? token : null} startDate={state.startDate} />}
          />
        )}
      </main>
    </div>
  );
}
