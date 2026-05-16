import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installMockApi } from './mockApi';
import './styles.css';

installMockApi();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
