import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/lib/monaco-loader'
import './index.css'
import App from './App.tsx'
import { Toaster } from '@/components/ui/sonner'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <Toaster theme="dark" position="bottom-right" richColors closeButton />
  </StrictMode>,
)
