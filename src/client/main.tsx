/** Entry of the built page: renders the panel into the `#root` of `index.html`. */
import { createRoot } from 'react-dom/client'
import { Standalone } from './host.tsx'

createRoot(document.getElementById('root')!).render(<Standalone />)
