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
      <div className="logo-container">
        <img src={process.env.PUBLIC_URL + '/logo app.png'} alt="NHOM5 Logo" className="app-logo" />
      </div>
      <h1>Hệ thống Cảnh báo lũ DUT</h1>
      <p>Chọn chức năng để vận hành hệ thống LoRa Mesh.</p>

      <div className="connection-status">
        <ConnectButton gatewayUrl={gatewayUrl} />
      </div>

      <div className="choice-grid">
        <button type="button" className="choice-card" onClick={() => setView('alert')}>
          <h2>Truyền tin cảnh báo</h2>
          <span>Gửi lệnh BAODONG và thông điệp khẩn cấp đến các trạm.</span>
        </button>

        <button type="button" className="choice-card" onClick={() => setView('map')}>
          <h2>Xem bản đồ giám sát</h2>
          <span>Theo dõi trạng thái node realtime trên bản đồ.</span>
        </button>
      </div>
    </main>
  );

  const renderHeader = (title) => (
    <header className="view-header">
      <button type="button" className="back-btn" onClick={() => setView('home')}>
        Quay lại
      </button>
      <h2>{title}</h2>
    </header>
  );

  return (
    <div className="App">
      {view === 'home' && renderHome()}
      {view === 'alert' && (
        <>
          {renderHeader('Truyền tin cảnh báo')}
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
