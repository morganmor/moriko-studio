/**
 * page-report.ts — the TEXT-FIRST page observation script shared by
 * browser_snapshot and the standalone screenshot tool. Runs IN the page
 * (untyped string script — Node's lib has no DOM), returns plain data.
 *
 * Interactive map: role, text, selector hint, bounding box, n — the agent can
 * say "click #7" via browser_click { x: box[0]+box[2]/2, y: box[1]+box[3]/2 }.
 */

export interface CaptureElement {
  n: number;
  role: string;
  text: string;
  box: [number, number, number, number];
  sel: string;
}

export interface CaptureReport {
  title: string;
  scrollY: number;
  viewport: { w: number; h: number; dpr: number };
  timing: { fcp: number; ttfb: number; lcp: number };
  interactive: CaptureElement[];
}

export const CAPTURE_SCRIPT = `(() => {
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  };
  const interactive = Array.from(document.querySelectorAll(
    'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=checkbox], [role=switch], summary, [contenteditable="true"], [onclick]'
  )).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && el.offsetParent !== null;
  }).slice(0, 60).map((el, i) => {
    const role = el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName.toLowerCase());
    const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return { n: i + 1, role, text, box: rect(el), sel: el.tagName.toLowerCase() + id + cls };
  });
  const paints = performance.getEntriesByType('paint');
  const nav = performance.getEntriesByType('navigation')[0];
  const lcpList = performance.getEntriesByType('largest-contentful-paint');
  const fcpEntry = paints ? paints.find((p) => p.name === 'first-contentful-paint') : null;
  return {
    title: document.title,
    scrollY: Math.round(window.scrollY),
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    timing: {
      fcp: fcpEntry ? Math.round(fcpEntry.startTime) : -1,
      ttfb: nav ? Math.round(nav.responseStart) : -1,
      lcp: lcpList && lcpList.length ? Math.round(lcpList[lcpList.length - 1].startTime) : -1,
    },
    interactive,
  };
})()`;
