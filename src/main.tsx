import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Login } from './pages/Login';
import './styles.css';
import { applyTheme } from './theme';
import './install';

applyTheme();

// Lets phones install the app to the home screen (see public/sw.js: it caches nothing).
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);

createRoot(document.getElementById('root')!).render(
  <StrictMode>{location.pathname === '/login' ? <Login /> : <App />}</StrictMode>,
);
