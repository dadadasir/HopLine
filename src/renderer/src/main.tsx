import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ViewBoundary } from './components/ViewBoundary'
import './index.css'

;(window as Window & { hoplinePerfStage?: (name: 'renderer-entry') => void }).hoplinePerfStage?.('renderer-entry')
const root = document.getElementById('root')
if (!root) throw new Error('missing root')
createRoot(root).render(<ViewBoundary root><App /></ViewBoundary>)
