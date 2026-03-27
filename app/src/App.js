import { useMemo, useState } from 'react';
import MapDashboard from './components/MapDashboard';
import AlertControl from './components/AlertControl';
import ConnectButton from './components/ConnectButton';
import './App.css';

function App() {
  const [view, setView] = useState('home');
  const gatewayUrl = useMemo(() => process.env.REACT_APP_GATEWAY_WS || 'ws://127.0.0.1:8765', []);

  const renderHome = () => (
    <main className="home-shell">
      <h1>He thong Canh bao Lu DUT</h1>
      <p>Chon chuc nang de van hanh he thong LoRa Mesh.</p>

      <div className="connection-status">
        <ConnectButton gatewayUrl={gatewayUrl} />
      </div>

      <div className="choice-grid">
        <button type="button" className="choice-card" onClick={() => setView('alert')}>
          <h2>Truyen tin canh bao</h2>
          <span>Gui lenh BAODONG va thong diep khan cap den cac tram.</span>
        </button>

        <button type="button" className="choice-card" onClick={() => setView('map')}>
          <h2>Xem map giam sat</h2>
          <span>Theo doi trang thai node realtime tren ban do.</span>
        </button>
      </div>
    </main>
  );

  const renderHeader = (title) => (
    <header className="view-header">
      <button type="button" className="back-btn" onClick={() => setView('home')}>
        Quay lai
      </button>
      <h2>{title}</h2>
    </header>
  );

  return (
    <div className="App">
      {view === 'home' && renderHome()}
      {view === 'alert' && (
        <>
          {renderHeader('Truyen tin canh bao')}
          <AlertControl gatewayUrl={gatewayUrl} />
        </>
      )}
      {view === 'map' && (
        <>
          {renderHeader('Monitoring System')}
          <MapDashboard gatewayUrl={gatewayUrl} />
        </>
      )}
    </div>
  );
}

export default App;
