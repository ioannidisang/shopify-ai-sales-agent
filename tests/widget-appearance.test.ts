import { describe, expect, it } from 'vitest';
import { brandVariables, contrastingText } from '../apps/widget/src/appearance.js';

describe('merchant appearance settings', () => {
  it('uses dark text on the yellow pilot buttons and light text on a charcoal header', () => {
    const palette = brandVariables({});
    expect(palette['--sa-accent']).toBe('#f4d538');
    expect(palette['--sa-accent-ink']).toBe('#171717');
    expect(palette['--sa-header-ink']).toBe('#ffffff');
  });
  it('rejects arbitrary CSS while accepting per-store hex colors', () => {
    const palette = brandVariables({ accent: '#0099FF', header: 'url(https://example.com/track)', surface: 'red;display:none' });
    expect(palette['--sa-accent']).toBe('#0099ff');
    expect(palette['--sa-header']).toBe('#171717');
    expect(palette['--sa-surface']).toBe('#faf9f2');
  });
  it('adapts foreground text for custom dark surfaces', () => {
    expect(contrastingText('#101010')).toBe('#ffffff');
    expect(brandVariables({ surface: '#101010' })['--sa-ink']).toBe('#ffffff');
    expect(contrastingText('#ffffff')).toBe('#171717');
    expect(contrastingText('#777777')).toBe('#000000');
  });
});
