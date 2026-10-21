import { Link, Route, Routes } from 'react-router-dom'
import { Shell } from './components/Shell'
import { Empty } from './components/ui'
import { AuraProvider } from './lib/aura'
import CommandCenter from './pages/CommandCenter'
import History from './pages/History'
import Home from './pages/Home'
import Memory from './pages/Memory'

export default function App() {
  return (
    <AuraProvider>
      <Shell>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/command" element={<CommandCenter />} />
          <Route path="/runs/:runId" element={<CommandCenter />} />
          <Route path="/memory" element={<Memory />} />
          <Route path="/history" element={<History />} />
          <Route
            path="*"
            element={
              <div className="mx-auto max-w-md py-16">
                <Empty>
                  Page not found. <Link to="/" className="text-lav-300 underline">Go home</Link>
                </Empty>
              </div>
            }
          />
        </Routes>
      </Shell>
    </AuraProvider>
  )
}
