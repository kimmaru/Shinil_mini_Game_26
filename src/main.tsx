// Entry point. Deliberately thin.
//
// The engine's services (pose source, gesture service, audio, the fixed-step
// loop) are handed to <App services={…}/>. They are OPTIONAL by design: with
// none attached the shell still boots, every screen renders, and the keyboard
// path completes a whole flow. A half-built engine must never show a child a
// frozen page.
//
// When src/engine/session.ts and loop.ts land, compose them here — this is the
// only file that needs to change.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/base.css';
import { App } from './shell/App';
import type { ShellServices } from './shell/useSession';

const services: ShellServices = {};

const host = document.getElementById('root');
if (!host) throw new Error('#root is missing from index.html');

createRoot(host).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);
