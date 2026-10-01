function color(value: string | undefined, fallback: string): string {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

export function contrastingText(background: string): '#171717' | '#ffffff' | '#000000' {
  const components = [1, 3, 5].map(index => Number.parseInt(background.slice(index, index + 2), 16) / 255);
  const linear = components.map(component => component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4);
  const luminance = linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
  if ((luminance + 0.05) / (0.008568 + 0.05) >= 4.5) return '#171717';
  if (1.05 / (luminance + 0.05) >= 4.5) return '#ffffff';
  return '#000000';
}

export function brandVariables(input: { header?: string; surface?: string; accent?: string }): Record<string, string> {
  const header = color(input.header, '#171717');
  const surface = color(input.surface, '#faf9f2');
  const accent = color(input.accent, '#f4d538');
  return {
    '--sa-header': header, '--sa-header-ink': contrastingText(header),
    '--sa-surface': surface, '--sa-ink': contrastingText(surface),
    '--sa-accent': accent, '--sa-accent-ink': contrastingText(accent),
  };
}

export function lockPageScroll(): () => void {
  const bodyStyle = document.body.getAttribute('style');
  const rootStyle = document.documentElement.getAttribute('style');
  const { scrollX, scrollY } = window;
  document.documentElement.style.setProperty('overflow', 'hidden', 'important');
  document.body.style.setProperty('overflow', 'hidden', 'important');
  document.body.style.setProperty('position', 'fixed', 'important');
  document.body.style.setProperty('top', `${-scrollY}px`, 'important');
  document.body.style.setProperty('left', `${-scrollX}px`, 'important');
  document.body.style.setProperty('width', '100%', 'important');
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (bodyStyle === null) document.body.removeAttribute('style'); else document.body.setAttribute('style', bodyStyle);
    if (rootStyle === null) document.documentElement.removeAttribute('style'); else document.documentElement.setAttribute('style', rootStyle);
    window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
  };
}
