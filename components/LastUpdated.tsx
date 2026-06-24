'use client';
import { useState, useEffect } from 'react';
import { useTeachers } from '@/lib/TeachersContext';

export function LastUpdated() {
  const { lastUpdated } = useTeachers();
  const [, setTick] = useState(0);

  // Re-render every 15 s so the label stays fresh
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  if (!lastUpdated) return null;

  const seconds = Math.floor((Date.now() - lastUpdated.getTime()) / 1000);
  let label: string;
  if (seconds < 10)        label = 'Actualizado ahora';
  else if (seconds < 60)   label = `Actualizado hace ${seconds} seg`;
  else if (seconds < 3600) label = `Actualizado hace ${Math.floor(seconds / 60)} min`;
  else                     label = `Actualizado hace ${Math.floor(seconds / 3600)} h`;

  return (
    <div style={{
      textAlign: 'center',
      fontSize: 10,
      color: 'var(--text-muted)',
      paddingBottom: 6,
      userSelect: 'none',
      letterSpacing: '0.02em',
    }}>
      {label}
    </div>
  );
}
