import { describe, expect, it } from 'vitest';
import { clipLabel } from '@/lib/testimonials';

describe('clips', () => {
  it('clipLabel: "16 jul · 8:20 – 8:27"', () => {
    expect(clipLabel({ classDate: '2026-07-16', start: 500, end: 507 })).toBe('16 jul · 8:20 – 8:27');
    expect(clipLabel({ classDate: '2026-09-03', start: 3725, end: 3734 })).toBe('3 sep · 1:02:05 – 1:02:14');
  });
});
