// The tuner's sliders, shared by tools/tune.html and tools/compare.html. buildControls(container, onChange) draws them
// and returns settings() (what to send to /api/tune: the art size always, everything else once changed), reset(),
// set(key, value, { quiet }) and showResolved(result). renderTuned(scene, settings) calls the API.

/* text from manifests, scenes and URLs goes into pages escaped */
export const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
/* only paths on this server: a page that loads scripts or manifests from elsewhere would run them on this origin */
export const sameOrigin = url => {
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
};

export const GROUPS = [
  ['Pixels', [
    { key: 'art', label: 'Art pixels across', min: 32, max: 512, step: 16, value: 128, always: true },
    { key: 'zoom', label: 'Zoom', min: 0.5, max: 3, step: 0.05, value: 1 }
  ]],
  ['Splats (bake)', [
    { key: 'res', label: 'Splat spacing', min: 0.006, max: 0.15, step: 0.002, value: 0.03, auto: true },
    { key: 'resFactor', label: 'Auto spacing in pixels (2 = fast preview)', min: 0.5, max: 3, step: 0.25, value: 1 }
  ]],
  ['Shading (bake)', [
    { key: 'shadeSteps', label: 'Shade steps', min: 2, max: 8, step: 1, value: 4 },
    { key: 'matDither', label: 'Ramp dither', options: ['none', 'bayer', 'checker', 'diagonal'], value: 'none' },
    { key: 'paletteDither', label: 'Palette dither', min: 0, max: 1, step: 0.05, value: 0 },
    { key: 'edgeHardness', label: 'Edge hardness', min: 0, max: 1, step: 0.05, value: 1 }
  ]],
  ['Light (bake)', [
    { key: 'sunYaw', label: 'Sun direction', min: -180, max: 180, step: 5, value: -40, pair: 'sunHeight' },
    { key: 'sunHeight', label: 'Sun height', min: 5, max: 90, step: 1, value: 50, pair: 'sunYaw' },
    { key: 'amb', label: 'Ambient', min: 0, max: 0.6, step: 0.01, value: 0.16 },
    { key: 'sky', label: 'Sky', min: 0, max: 0.6, step: 0.01, value: 0.3 }
  ]],
  ['Camera', [
    { key: 'yaw', label: 'Turn', min: -3.14, max: 3.14, step: 0.02, value: 0.6 },
    { key: 'pitch', label: 'Tilt', min: -0.2, max: 1.55, step: 0.01, value: 0.35 },
    { key: 'ortho', label: 'Orthographic', check: true, value: false }
  ]],
  ['Look', [
    { key: 'colored', label: 'Coloured outlines', check: true, value: false },
    { key: 'raw', label: 'Raw (no palette styling)', check: true, value: false }
  ]]
];

export const STYLE = `
  .tune h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 14px 0 4px; }
  .tune .control { margin: 4px 0 8px; }
  .tune .control label { display: flex; justify-content: space-between; color: var(--muted); gap: 8px; }
  .tune .control label span:last-child { color: var(--text); font-variant-numeric: tabular-nums; }
  .tune .control.dirty label span:first-child, .tune .control.dirty .check { color: var(--accent); }
  .tune input[type=range] { width: 100%; accent-color: var(--accent); }
  .tune select { width: 100%; background: #26282f; color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 4px 6px; font: inherit; }
  .tune .check { display: flex; gap: 6px; align-items: center; margin: 4px 0; color: var(--muted); }`;

export function buildControls(container, onChange, { groups = GROUPS } = {}) {
  container.classList.add('tune');
  const controls = new Map(), dirty = new Set();
  let autoRes = true;
  for (const [title, list] of groups) {
    container.insertAdjacentHTML('beforeend', `<h2>${title}</h2>`);
    for (const c of list) {
      const div = document.createElement('div');
      div.className = 'control';
      if (c.check) div.innerHTML = `<label class="check"><input type="checkbox"> ${c.label}</label>`;
      else if (c.options) div.innerHTML = `<label><span>${c.label}</span><span></span></label><select>${c.options.map(o => `<option>${o}</option>`).join('')}</select>`;
      else div.innerHTML = `<label><span>${c.label}</span><span></span></label><input type="range" min="${c.min}" max="${c.max}" step="${c.step}">` +
        (c.auto ? `<label class="check"><input type="checkbox" checked data-auto> follow the pixel size</label>` : '');
      container.append(div);
      const input = div.querySelector(c.check ? 'input[type=checkbox]' : c.options ? 'select' : 'input[type=range]');
      const entry = { ...c, div, input, show: div.querySelector('label span:last-child') };
      controls.set(c.key, entry);
      put(entry, c.value);
      input.addEventListener('input', () => {
        if (c.key === 'res') setAuto(false);
        dirty.add(c.key);
        if (c.pair) dirty.add(c.pair);
        refresh(entry);
        onChange(c.key);
      });
      if (c.auto) div.querySelector('[data-auto]').addEventListener('change', e => { setAuto(e.target.checked); onChange('res'); });
    }
  }
  function setAuto(on) {
    autoRes = on;
    const res = controls.get('res');
    if (!res) return;
    res.div.querySelector('[data-auto]').checked = on;
    if (on) dirty.delete('res');
    refresh(res);
  }
  function put(entry, value) {
    if (entry.check) entry.input.checked = Boolean(value);
    else entry.input.value = value;
    refresh(entry);
  }
  function valueOf(entry) {
    if (entry.check) return entry.input.checked;
    if (entry.options) return entry.input.value;
    return Number(entry.input.value);
  }
  function refresh(entry) {
    entry.div.classList.toggle('dirty', dirty.has(entry.key) || (entry.key === 'res' && !autoRes));
    if (entry.show) entry.show.textContent = entry.key === 'res' && autoRes ? 'auto' : valueOf(entry);
  }
  return {
    settings() {
      const out = {};
      for (const [key, entry] of controls) if (key !== 'res' && (entry.always || dirty.has(key))) out[key] = valueOf(entry);
      if (controls.has('res')) out.res = autoRes ? 'auto' : valueOf(controls.get('res'));
      return out;
    },
    reset() {
      dirty.clear();
      for (const [, entry] of controls) put(entry, entry.value);
      setAuto(true);
    },
    /* quiet: show a value without marking it changed (the scene's own camera, a resolved spacing) */
    set(key, value, { quiet = false } = {}) {
      const entry = controls.get(key);
      if (!entry) return;
      /* an explicit spacing means the automatic one is off */
      if (key === 'res') return value === 'auto' ? setAuto(true) : (setAuto(false), put(entry, value));
      if (!quiet) dirty.add(key);
      put(entry, value);
    },
    isDirty: key => dirty.has(key),
    changed: () => dirty.size > 0 || !autoRes
  };
}

export async function renderTuned(scene, settings) {
  const response = await fetch('/api/tune', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scene, settings }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

export async function saveTuned(scene, settings) {
  const response = await fetch('/api/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scene, settings }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
