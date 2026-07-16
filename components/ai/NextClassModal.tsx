'use client';

// Clase generada por la IA: se genera al abrir (si no viene cacheada), se puede
// copiar entera al portapapeles y marcar como lista.

import { useEffect, useRef, useState } from 'react';
import { generateNextClassClient, saveNextClass } from '@/lib/aiClient';
import type { FichaIA, NextClassIA, TranscriptIA } from '@/lib/aiTypes';
import { NextClassView, nextClassToText, DRC } from '@/components/ai/FichaView';
import { Modal, ModalHeader, primaryBtn, ghostBtn, outlineBtn, errBox, okBox } from '@/components/ai/modalUi';

interface Props {
  profileId: string;
  studentName: string;
  teacherName: string;
  classNumber: number;
  ficha: FichaIA;
  lastAnalysis?: TranscriptIA | null;
  classHistory?: unknown[] | null;
  plan?: string | null;
  level?: string | null;
  cached?: NextClassIA | null;
  onSaved: (nc: NextClassIA) => void;
  onClose: () => void;
}

const SPINNER_MSGS = [
  'Repasando la ficha del alumno...',
  'Revisando la última clase...',
  'Diseñando las actividades...',
  'Escribiendo el material...',
];

export default function NextClassModal(props: Props) {
  const [nextClass, setNextClass] = useState<NextClassIA | null>(props.cached ?? null);
  const [loading, setLoading] = useState(!props.cached);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [marked, setMarked] = useState(false);
  const [saving, setSaving] = useState(false);

  const params = {
    profileId: props.profileId,
    studentName: props.studentName,
    teacherName: props.teacherName,
    classNumber: props.classNumber,
    studentProfile: props.ficha,
    lastAnalysis: props.lastAnalysis ?? null,
    classHistory: props.classHistory ?? null,
    plan: props.plan,
    level: props.level,
  };

  // Generación automática al abrir (sin setState síncrono dentro del efecto).
  useEffect(() => {
    if (props.cached) return;
    let cancelled = false;
    (async () => {
      try {
        const nc = await generateNextClassClient(params);
        if (!cancelled) setNextClass(nc);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'No se pudo generar la clase.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function regenerate() {
    setLoading(true);
    setError(null);
    setMarked(false);
    try {
      setNextClass(await generateNextClassClient(params));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo generar la clase.');
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    if (!nextClass) return;
    const text = nextClassToText(nextClass, props.studentName);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Sin permiso de portapapeles (http, Safari viejo): fallback manual.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* no hay más que hacer */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  }

  async function markReady() {
    if (!nextClass) return;
    setSaving(true);
    setError(null);
    try {
      await saveNextClass(props.profileId, nextClass);
      setMarked(true);
      props.onSaved(nextClass);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar la clase.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={props.onClose} locked={loading || saving} maxWidth={720}>
      <ModalHeader
        title={`✨ Clase ${props.classNumber} preparada — ${props.studentName}`}
        subtitle={nextClass?.classTitle}
        onClose={props.onClose}
        locked={loading || saving}
      />

      {loading ? (
        <RotatingSpinner />
      ) : error && !nextClass ? (
        <>
          <div style={errBox}>⚠️ {error}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
            <button onClick={props.onClose} style={ghostBtn}>Cerrar</button>
            <button onClick={regenerate} style={primaryBtn}>🔄 Reintentar</button>
          </div>
        </>
      ) : nextClass ? (
        <>
          {marked && <div style={{ ...okBox, marginBottom: 12 }}>✅ Clase marcada como lista. Aparecerá en la ficha del alumno.</div>}
          {error && <div style={{ ...errBox, marginBottom: 12 }}>⚠️ {error}</div>}

          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            <button onClick={copy} style={outlineBtn}>
              {copied ? '✅ Copiada' : '📋 Copiar clase completa'}
            </button>
            <button onClick={markReady} disabled={saving || marked} style={{ ...outlineBtn, opacity: saving || marked ? 0.55 : 1 }}>
              {marked ? '✅ Marcada como lista' : saving ? 'Guardando…' : '✅ Marcar clase como lista'}
            </button>
            <button onClick={regenerate} style={ghostBtn}>🔄 Regenerar</button>
          </div>

          <NextClassView nc={nextClass} />
        </>
      ) : null}
    </Modal>
  );
}

function RotatingSpinner() {
  const [i, setI] = useState(0);
  const ref = useRef(0);
  useEffect(() => {
    const t = setInterval(() => { ref.current = (ref.current + 1) % SPINNER_MSGS.length; setI(ref.current); }, 2600);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ padding: '44px 0', textAlign: 'center' }}>
      <style dangerouslySetInnerHTML={{ __html: `@keyframes drc-spin2{to{transform:rotate(360deg)}}` }} />
      <div style={{
        width: 34, height: 34, margin: '0 auto 16px', borderRadius: '50%',
        border: '3px solid #e5e7eb', borderTopColor: DRC.green, animation: 'drc-spin2 0.8s linear infinite',
      }} />
      <div style={{ fontSize: 14, fontWeight: 600, color: '#374151' }}>{SPINNER_MSGS[i]}</div>
      <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 6 }}>Generar una clase completa puede tardar un minuto.</div>
    </div>
  );
}
