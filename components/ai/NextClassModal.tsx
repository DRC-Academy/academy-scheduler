'use client';

// Clase generada por la IA: se genera al abrir (si no viene cacheada), se puede
// copiar entera al portapapeles y marcar como lista.

import { useEffect, useRef, useState } from 'react';
import { generateNextClassClient, saveNextClass } from '@/lib/aiClient';
import { isConversacionGuiada, type ClassType, type FichaIA, type GeneratedClassIA, type TranscriptIA } from '@/lib/aiTypes';
import { viableClassTypes, normalizeLevel } from '@/lib/drcMethodology';
import { printClassPdf } from '@/lib/classDoc';
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
  cached?: GeneratedClassIA | null;
  onSaved: (nc: GeneratedClassIA) => void;
  onClose: () => void;
}

const SPINNER_MSGS = [
  'Repasando la ficha del alumno...',
  'Revisando la última clase...',
  'Diseñando las actividades...',
  'Escribiendo el material...',
];

export default function NextClassModal(props: Props) {
  const [nextClass, setNextClass] = useState<GeneratedClassIA | null>(props.cached ?? null);
  const [loading, setLoading] = useState(!props.cached);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [marked, setMarked] = useState(false);
  const [saving, setSaving] = useState(false);
  // Tipo de clase del avatar. Conversación guiada solo es elegible en B1+.
  const [classType, setClassType] = useState<ClassType>(
    isConversacionGuiada(props.cached) ? 'conversacion_guiada' : 'metodologia_aplicada',
  );
  const viable = viableClassTypes(normalizeLevel(props.level), props.ficha.domain);
  const canChooseType = viable.includes('conversacion_guiada');

  function buildParams(ct: ClassType) {
    return {
      profileId: props.profileId,
      studentName: props.studentName,
      teacherName: props.teacherName,
      classNumber: props.classNumber,
      studentProfile: props.ficha,
      lastAnalysis: props.lastAnalysis ?? null,
      classHistory: props.classHistory ?? null,
      plan: props.plan,
      level: props.level,
      domain: props.ficha.domain,
      classType: ct,
    };
  }

  // Generación automática al abrir (sin setState síncrono dentro del efecto).
  useEffect(() => {
    if (props.cached) return;
    let cancelled = false;
    (async () => {
      try {
        const nc = await generateNextClassClient(buildParams(classType));
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

  async function regenerate(ct: ClassType = classType) {
    setLoading(true);
    setError(null);
    setMarked(false);
    try {
      setNextClass(await generateNextClassClient(buildParams(ct)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo generar la clase.');
    } finally {
      setLoading(false);
    }
  }

  // Cambiar de tipo de clase regenera con el nuevo modo.
  async function switchType(ct: ClassType) {
    if (ct === classType || loading) return;
    setClassType(ct);
    await regenerate(ct);
  }

  function downloadPdf() {
    if (!nextClass) return;
    printClassPdf(nextClass, {
      studentName: props.studentName,
      teacherName: props.teacherName,
      level: props.level,
      classTypeLabel: isConversacionGuiada(nextClass) ? 'Conversación guiada' : 'Metodología aplicada',
    });
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

      {canChooseType && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Tipo de clase:</span>
          {([
            ['metodologia_aplicada', '📚 Metodología aplicada'],
            ['conversacion_guiada', '💬 Conversación guiada'],
          ] as const).map(([ct, label]) => (
            <button key={ct} onClick={() => switchType(ct)} disabled={loading || saving}
              style={{
                padding: '6px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: classType === ct ? 700 : 500,
                fontFamily: 'inherit', cursor: loading || saving ? 'not-allowed' : 'pointer',
                border: `1.5px solid ${classType === ct ? DRC.green : '#d1d5db'}`,
                background: classType === ct ? 'rgba(30,158,58,0.1)' : 'transparent',
                color: classType === ct ? DRC.greenDark : '#6b7280', opacity: loading || saving ? 0.6 : 1,
              }}>
              {label}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <RotatingSpinner />
      ) : error && !nextClass ? (
        <>
          <div style={errBox}>⚠️ {error}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
            <button onClick={props.onClose} style={ghostBtn}>Cerrar</button>
            <button onClick={() => regenerate()} style={primaryBtn}>🔄 Reintentar</button>
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
            <button onClick={downloadPdf} style={outlineBtn}>⬇️ Descargar PDF</button>
            <button onClick={markReady} disabled={saving || marked} style={{ ...outlineBtn, opacity: saving || marked ? 0.55 : 1 }}>
              {marked ? '✅ Marcada como lista' : saving ? 'Guardando…' : '✅ Marcar clase como lista'}
            </button>
            <button onClick={() => regenerate()} style={ghostBtn}>🔄 Regenerar</button>
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
