import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import FieldReport from './FieldReport.jsx';
import { registerSW } from './registerSW.js';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <FieldReport />
  </StrictMode>
);

registerSW({
  onUpdate: (apply) => {
    // Deliberately not auto-reloading: a reload mid-walkdown would discard
    // an in-progress dictation. Surface it and let the user pick the moment.
    if (document.getElementById('fr-update-bar')) return;
    const bar = document.createElement('button');
    bar.id = 'fr-update-bar';
    bar.type = 'button';
    bar.textContent = 'NEW VERSION READY — TAP TO UPDATE';
    bar.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:9999',
      'padding:16px', 'padding-bottom:calc(16px + env(safe-area-inset-bottom))',
      'background:#fbbf24', 'color:#0a0a0a', 'border:0', 'cursor:pointer',
      'font:600 11px ui-monospace,SFMono-Regular,monospace', 'letter-spacing:.15em',
    ].join(';');
    bar.onclick = () => { bar.textContent = 'UPDATING…'; apply(); };
    document.body.appendChild(bar);
  },
});
