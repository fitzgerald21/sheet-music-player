import { createRoot } from 'react-dom/client';
import { isolate } from './isolation';
import { App } from './ui/App';
import './ui/styles.css';

isolate();
createRoot(document.getElementById('root')!).render(<App />);
