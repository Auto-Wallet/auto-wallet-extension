import React from 'react';
import { createRoot } from 'react-dom/client';
import '../popup/styles.css';
import { initTheme } from '../popup/theme';
import { OkxSwapPage } from './OkxSwapPage';

initTheme();

// Like the bridge page, the OKX swap page lives in its own tab; let the body
// fill the viewport instead of the 360px popup width.
document.body.style.width = '100vw';
document.body.style.minHeight = '100vh';

const root = createRoot(document.getElementById('root')!);
root.render(<OkxSwapPage />);
