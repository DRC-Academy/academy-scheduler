'use client';
import { useState, useEffect } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { calcCurrentClassNumber } from '@/lib/db';
import { classCategoryBadge } from '@/lib/finance';
import { Assignment, Grid } from '@/types';

// Estima la fecha de un milestone de clase según la fecha de inicio y los días/semana.
function estimateMilestoneDate(startDate: string, milestone: number, slotsPerWeek: number): string {
  const weeksNeeded = Math.ceil(milestone / slotsPerWeek);
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const start  = new Date(sy, sm - 1, sd);
  const target = new Date(start.getTime() + weeksNeeded * 7 * 24 * 60 * 60 * 1000);
  return target.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

function ContadorContent() {
  const { user } = useAuth();
  const { teachers, assignments, getTeacherGrid, reloadAll, updateAssignmentAdjustment, updateAssignmentStartDate } = useTeachers();

  const teacher = teachers.find(t => t.id === user?.teacherId) ?? teachers[0];

  const [grid, setGrid] = useState<Grid>({});
  const [deductConfirm, setDeductConfirm] = useState<Assignment | null>(null);
  const [startDateModal, setStartDateModal] = useState<{ assignment: Assignment; date: string } | null>(null);
  const [adjustSaving, setAdjustSaving] = useState<string | null>(null);

  // Cargar la grilla del profesor (para detectar alumnos "legacy" sin assignment).
  useEffect(() => {
    if (!teacher) return;
    getTeacherGrid(teacher.id).then(setGrid);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacher?.id]);

  async function handleAdjust(a: Assignment, delta: number) {
    setAdjustSaving(a.id);
    const newAdj = (a.manualClassAdjustment ?? 0) + delta;
    await updateAssignmentAdjustment(a.id, newAdj);
    setAdjustSaving(null);
  }

  async function handleDeductConfirmAction() {
    if (!deductConfirm) return;
    await handleAdjust(deductConfirm, -1);
    setDeductConfirm(null);
  }

  async function handleStartDateSave() {
    if (!startDateModal) return;
    await updateAssignmentStartDate(startDateModal.assignment.id, startDateModal.date);
    setStartDateModal(null);
  }

  const myAssignments = teacher ? assignments.filter(a => a.teacherId === teacher.id) : [];

  // Alumnos solo-grilla (celdas ocupado sin assignment en DB).
  const assignedNames = new Set(myAssignments.map(a => a.studentName));
  const gridOcupado = Object.entries(grid)
    .filter(([, cell]) => cell.state === 'ocupado' && cell.student && !assignedNames.has(cell.student))
    .map(([key, cell]) => { const [day, hour] = key.split('_'); return { day, hour, student: cell.student! }; });
  const legacyMap = new Map<string, { student: string; slots: { day: string; hour: string }[] }>();
  for (const c of gridOcupado) {
    if (!legacyMap.has(c.student)) legacyMap.set(c.student, { student: c.student, slots: [] });
    legacyMap.get(c.student)!.slots.push({ day: c.day, hour: c.hour });
  }
  const legacyList = Array.from(legacyMap.values());

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <PullToRefresh onRefresh={reloadAll}>
        <div style={{ maxWidth: 980, margin: '0 auto', padding: '32px 16px 48px' }}>
          <LastUpdated />
          <div style={{ marginBottom: 24 }}>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>📊 Conteo automático</h1>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>Seguimiento de clases por alumno — se actualiza automáticamente</p>
          </div>

          {!teacher ? (
            <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)' }}>Cargando...</div>
          ) : (
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px' }}>
              <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 4 }}>Mis alumnos — Contador automático</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 18 }}>El contador se actualiza automáticamente según la fecha de inicio y los días asignados.</div>

              {myAssignments.length === 0 && legacyList.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 14 }}>
                  No tenés alumnos asignados todavía.<br />
                  <span style={{ fontSize: 12 }}>Hacé clic en una celda "Ocupado" del calendario para asignar un alumno.</span>
                </div>
              ) : (
                <>
                  {/* DB assignments with auto class count */}
                  {myAssignments.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                      {myAssignments.map(a => {
                        const classNum = calcCurrentClassNumber(a);
                        const barPct   = Math.min(100, (classNum / 30) * 100);
                        const slotsPerWeek = a.slots.length;
                        const est15 = a.startDate ? estimateMilestoneDate(a.startDate, 15, slotsPerWeek) : null;
                        const est30 = a.startDate ? estimateMilestoneDate(a.startDate, 30, slotsPerWeek) : null;

                        return (
                          <div key={a.id} style={{ background: 'var(--bg-surface-2)', border: `1px solid ${classNum >= 30 ? '#1E9E3A' : classNum >= 15 ? '#FFC400' : 'var(--border)'}`, borderRadius: 12, padding: '16px 20px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
                              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                                <div style={{ width: 42, height: 42, borderRadius: '50%', background: 'rgba(30,158,58,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, fontWeight: 700, color: '#1E9E3A', flexShrink: 0 }}>
                                  {a.studentName.charAt(0).toUpperCase()}
                                </div>
                                <div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                                    <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-primary)' }}>{a.studentName}</span>
                                    {(() => { const cat = classCategoryBadge(a.plan || a.objetivo); return (
                                      <span style={{ fontSize: 10, padding: '1px 9px', borderRadius: 10, background: cat.bg, color: cat.color, fontWeight: 700 }}>{cat.label}</span>
                                    ); })()}
                                  </div>
                                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                                    {a.slots.map(sl => `${sl.day} ${sl.hour}`).join(' · ')}
                                    {a.studentLevel && ` · ${a.studentLevel}`}
                                  </div>
                                </div>
                              </div>
                              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                                <div style={{ fontSize: 18, fontWeight: 800, color: classNum >= 30 ? '#1E9E3A' : classNum >= 15 ? '#b45309' : 'var(--text-primary)' }}>
                                  Clase {classNum}
                                </div>
                                {classNum >= 30 && <div style={{ fontSize: 11, color: '#1E9E3A', fontWeight: 700 }}>🏆 Milestone</div>}
                                {classNum >= 15 && classNum < 30 && <div style={{ fontSize: 11, color: '#b45309', fontWeight: 700 }}>🎯 Milestone</div>}
                              </div>
                            </div>

                            {/* Progress bar */}
                            <div style={{ position: 'relative', marginBottom: 6 }}>
                              <div style={{ height: 10, borderRadius: 5, background: '#e5e7eb', overflow: 'hidden' }}>
                                <div style={{ width: `${barPct}%`, height: '100%', background: classNum >= 30 ? '#1E9E3A' : classNum >= 15 ? '#FFC400' : '#3b82f6', borderRadius: 5, transition: 'width 0.4s ease' }} />
                              </div>
                              <div style={{ position: 'absolute', left: '50%', top: 0, width: 2, height: 10, background: '#FFC400', transform: 'translateX(-50%)', zIndex: 2, pointerEvents: 'none' }} />
                            </div>
                            <div style={{ position: 'relative', height: 15, fontSize: 10, color: 'var(--text-muted)', marginBottom: 10 }}>
                              <span style={{ position: 'absolute', left: 0 }}>Clase 1</span>
                              <span style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)' }}>15</span>
                              <span style={{ position: 'absolute', right: 0 }}>30</span>
                            </div>

                            {/* Estimated dates */}
                            {a.startDate && (
                              <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-muted)' }}>
                                <span>Inicio: <b>{new Date(a.startDate + 'T00:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}</b></span>
                                {classNum < 15 && est15 && <span>Clase 15 est.: <b>{est15}</b></span>}
                                {classNum < 30 && est30 && <span>Clase 30 est.: <b>{est30}</b></span>}
                              </div>
                            )}

                            {/* Action buttons */}
                            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                              <button
                                className="class-action-btn"
                                onClick={() => handleAdjust(a, +1)}
                                disabled={adjustSaving === a.id}
                                style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 7, border: '1px solid rgba(30,158,58,0.4)', background: 'rgba(30,158,58,0.08)', color: '#1E9E3A', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', opacity: adjustSaving === a.id ? 0.6 : 1 }}>
                                + Sumar clase
                              </button>
                              <button
                                className="class-action-btn"
                                onClick={() => setDeductConfirm(a)}
                                disabled={adjustSaving === a.id}
                                style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 7, border: '1px solid rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.07)', color: '#dc2626', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', opacity: adjustSaving === a.id ? 0.6 : 1 }}>
                                − Descontar clase
                              </button>
                              <button
                                className="class-action-btn"
                                onClick={() => setStartDateModal({ assignment: a, date: a.startDate ?? new Date().toISOString().split('T')[0] })}
                                style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-surface-3)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: 500, fontFamily: 'inherit' }}>
                                📅 Fecha inicio
                              </button>
                              {(a.manualClassAdjustment ?? 0) !== 0 && (
                                <span style={{ fontSize: 11, color: (a.manualClassAdjustment ?? 0) > 0 ? '#1E9E3A' : '#dc2626', alignSelf: 'center' }}>
                                  Ajuste manual: {(a.manualClassAdjustment ?? 0) > 0 ? '+' : ''}{a.manualClassAdjustment}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Legacy: grid-only ocupado students without a DB assignment */}
                  {legacyList.length > 0 && (
                    <div style={{ marginTop: myAssignments.length > 0 ? 20 : 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Sin registro de inicio</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {legacyList.map(s => (
                          <div key={s.student} style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'rgba(107,114,128,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#6b7280', flexShrink: 0 }}>
                              {s.student.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>{s.student}</div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.slots.map(sl => `${sl.day} ${sl.hour}`).join(' · ')}</div>
                            </div>
                            <div style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>Sin fecha de inicio registrada</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </PullToRefresh>

      {/* Deduct class confirmation modal */}
      {deductConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setDeductConfirm(null); }}>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 14, padding: 24, width: '100%', maxWidth: 380 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 10 }}>Confirmar falta</div>
            <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.5 }}>
              ¿Confirmás que <b>{deductConfirm.studentName}</b> faltó a la clase?
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setDeductConfirm(null)} style={{ flex: 1, padding: '9px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                Cancelar
              </button>
              <button onClick={handleDeductConfirmAction} style={{ flex: 2, padding: '9px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.15)', color: '#dc2626', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
                Sí, descontar clase
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Start date modal */}
      {startDateModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setStartDateModal(null); }}>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 14, padding: 24, width: '100%', maxWidth: 380 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 6 }}>Modificar fecha de inicio</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
              Alumno: <b style={{ color: 'var(--text-primary)' }}>{startDateModal.assignment.studentName}</b>
            </div>
            <input
              type="date"
              value={startDateModal.date}
              onChange={e => setStartDateModal(prev => prev ? { ...prev, date: e.target.value } : null)}
              style={{ width: '100%', marginBottom: 16 }}
            />
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setStartDateModal(null)} style={{ flex: 1, padding: '9px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                Cancelar
              </button>
              <button onClick={handleStartDateSave} disabled={!startDateModal.date} style={{ flex: 2, padding: '9px', borderRadius: 8, border: 'none', background: startDateModal.date ? '#1E9E3A' : 'var(--bg-surface-3)', color: startDateModal.date ? 'white' : 'var(--text-muted)', cursor: startDateModal.date ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
                Guardar fecha
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ConteoAutomaticoPage() {
  return (
    <AuthGuard allowedRoles={['teacher']}>
      <ContadorContent />
    </AuthGuard>
  );
}
