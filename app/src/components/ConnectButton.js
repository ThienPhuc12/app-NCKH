import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import './ConnectButton.css';

function ConnectButton({ gatewayUrl }) {
  const [connectionStatus, setConnectionStatus] = useState('scanning'); // 'scanning', 'connected', 'error', 'disconnected'
  const [portName, setPortName] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [availablePorts, setAvailablePorts] = useState([]);
  const [selectedPort, setSelectedPort] = useState(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectButtonDisabled, setConnectButtonDisabled] = useState(false);
  
  const socketRef = useRef(null);
  const autoScanIntervalRef = useRef(null);
  const keepAliveTimeoutRef = useRef(null);

  // Initialize WebSocket and auto-scan logic
  useEffect(() => {
    const socket = new WebSocket(gatewayUrl);
    socketRef.current = socket;

    socket.onopen = () => {
      console.log('[ConnectButton] WebSocket connected');
      setConnectionStatus('scanning');
      setErrorMessage(null);
      
      // Start auto-scan every 5 seconds if disconnected
      if (autoScanIntervalRef.current) clearInterval(autoScanIntervalRef.current);
      autoScanIntervalRef.current = setInterval(() => {
        if (socketRef.current?.readyState === WebSocket.OPEN &&
            connectionStatus !== 'connected') {
          console.log('[ConnectButton] Auto-scanning for ports...');
          socketRef.current.send(JSON.stringify({ type: 'GET_PORTS' }));
        }
      }, 5000);
      
      // Initial port scan
      socket.send(JSON.stringify({ type: 'GET_PORTS' }));
    };

    socket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        
        // Handle port list
        if (parsed.type === 'PORT_LIST') {
          const ports = parsed.ports || [];
          setAvailablePorts(ports);
          console.log(`[ConnectButton] Received ${ports.length} ports:`, ports);
          
          // Auto-select Heltec if found
          const heltecPort = ports.find(p => p.is_heltec);
          if (heltecPort && !selectedPort) {
            setSelectedPort(heltecPort.device);
            console.log(`[ConnectButton] Auto-selected Heltec on ${heltecPort.device}`);
          }
        }
        
        // Handle error messages
        if (parsed.type === 'STATUS' && parsed.status === 'error') {
          console.error('[ConnectButton] Received error:', parsed.message);
          setConnectionStatus('error');
          setErrorMessage(parsed.message);
          setPortName(null);
        }

        // Handle explicit connection status updates from gateway
        if (parsed.type === 'CONNECTION_STATUS') {
          if (parsed.status === 'connected') {
            setConnectionStatus('connected');
            setPortName(parsed.port || 'Heltec V4');
            setErrorMessage(null);
            if (autoScanIntervalRef.current) clearInterval(autoScanIntervalRef.current);
            toast.success(`✓ Kết nối cổng ${parsed.port || ''} thành công`);
          } else if (parsed.status === 'scanning') {
            setConnectionStatus('connecting');
            if (parsed.port) {
              setPortName(parsed.port);
            }
          }
        }
        
        // Handle keep-alive (connection status) - THIS IS THE ONLY SOURCE OF TRUTH FOR CONNECTION STATUS
        if (parsed.type === 'KEEP_ALIVE') {
          if (parsed.status === 'connected') {
            if (connectionStatus !== 'connected') {
              console.log('[ConnectButton] Device connected - received keep-alive with status=connected');
              setConnectionStatus('connected');
              setErrorMessage(null);
              setPortName(parsed.port);
              if (autoScanIntervalRef.current) clearInterval(autoScanIntervalRef.current);
              toast.success(`✓ Kết nối thành công: ${parsed.port}`);
            }
          } else if (parsed.status === 'scanning') {
            if (connectionStatus === 'connected') {
              console.log('[ConnectButton] Connection lost - keep-alive status=scanning while was connected');
              setConnectionStatus('disconnected');
              setErrorMessage('Mất kết nối. Kiểm tra cáp USB hoặc cấu hình thiết bị.');
              setPortName(null);
              toast.warning('⚠ Mất kết nối thiết bị');
            }
          }
          
          // Reset keep-alive timeout
          if (keepAliveTimeoutRef.current) clearTimeout(keepAliveTimeoutRef.current);
          keepAliveTimeoutRef.current = setTimeout(() => {
            console.warn('[ConnectButton] Keep-alive timeout - no KEEP_ALIVE signal for 6 seconds');
            setConnectionStatus('disconnected');
          }, 6000);
        }
        
        // Node data messages - do NOT use to indicate connection status
        // These are just data updates and can arrive anytime during startup
        if (parsed.type === 'NODE_UPDATE' || parsed.type === 'nodes:update') {
          console.log('[ConnectButton] Received node data (ignored for connection status):', parsed.type);
          // Connection status is determined ONLY by KEEP_ALIVE message, not by node data
        }
      } catch (_error) {
        // Non-JSON messages, ignore
      }
    };

    socket.onerror = (error) => {
      console.error('[ConnectButton] WebSocket error:', error);
      setConnectionStatus('error');
      setErrorMessage('Lỗi kết nối WebSocket');
    };

    socket.onclose = () => {
      console.log('[ConnectButton] WebSocket closed');
      if (autoScanIntervalRef.current) clearInterval(autoScanIntervalRef.current);
      if (keepAliveTimeoutRef.current) clearTimeout(keepAliveTimeoutRef.current);
    };

    return () => {
      if (autoScanIntervalRef.current) clearInterval(autoScanIntervalRef.current);
      if (keepAliveTimeoutRef.current) clearTimeout(keepAliveTimeoutRef.current);
      socket.close();
    };
  }, [gatewayUrl]);

  const handleConnectClick = async () => {
    if (!selectedPort) {
      toast.warning('⚠ Vui lòng chọn cổng COM');
      return;
    }

    if (isConnecting || connectButtonDisabled) {
      return;
    }

    setIsConnecting(true);
    setConnectButtonDisabled(true);

    try {
      console.log(`[ConnectButton] Attempting to connect to ${selectedPort}...`);
      setConnectionStatus('connecting');
      
      // Explicitly request gateway to connect selected COM port
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(
          JSON.stringify({ type: 'CONNECT_PORT', port: selectedPort })
        );
      }
      
      // Disable button for 3 seconds
      await new Promise(resolve => setTimeout(resolve, 3000));
    } finally {
      setIsConnecting(false);
      setConnectButtonDisabled(false);
    }
  };

  const handleRetry = () => {
    console.log('[ConnectButton] User clicked retry');
    setConnectionStatus('scanning');
    setErrorMessage(null);
    
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'GET_PORTS' }));
      toast.info('🔄 Đang quét lại thiết bị...');
    }
  };

  return (
    <div className="connect-button-container">
      {/* Error Alert */}
      {connectionStatus === 'error' && errorMessage && (
        <div className="error-alert">
          <span className="error-icon">⚠️</span>
          <div className="error-content">
            <p className="error-message">{errorMessage}</p>
            <button className="retry-button" onClick={handleRetry}>
              🔄 Thử kết nối lại
            </button>
          </div>
          <button
            className="close-alert"
            onClick={() => {
              setErrorMessage(null);
              setConnectionStatus('scanning');
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Status Display */}
      <div className={`status-display ${connectionStatus}`}>
        {connectionStatus === 'scanning' && (
          <>
            <span className="status-spinner">⏳</span>
            <span className="status-text">Đang quét thiết bị...</span>
          </>
        )}

        {connectionStatus === 'connecting' && (
          <>
            <span className="status-spinner">🔄</span>
            <span className="status-text">Đang kết nối...</span>
          </>
        )}

        {connectionStatus === 'connected' && (
          <>
            <span className="status-icon">✓</span>
            <span className="status-text">Đã kết nối: {portName || 'Heltec V4'}</span>
          </>
        )}

        {connectionStatus === 'disconnected' && (
          <>
            <span className="status-icon">⚠</span>
            <span className="status-text">Mất kết nối</span>
          </>
        )}

        {connectionStatus === 'error' && (
          <>
            <span className="status-icon">✕</span>
            <span className="status-text">Lỗi kết nối</span>
          </>
        )}
      </div>

      {/* Port Selection and Connect Button */}
      {connectionStatus !== 'connected' && (
        <>
          {availablePorts.length > 0 ? (
            <div className="port-selector">
              <select
                value={selectedPort || ''}
                onChange={(e) => setSelectedPort(e.target.value)}
                className="port-dropdown"
              >
                <option value="">-- Chọn cổng COM --</option>
                {availablePorts.map((port) => (
                  <option key={port.device} value={port.device}>
                    {port.device} {port.is_heltec ? '(Heltec)' : ''} - {port.description}
                  </option>
                ))}
              </select>
              <button
                className="connect-button"
                onClick={handleConnectClick}
                disabled={connectButtonDisabled || !selectedPort || isConnecting}
              >
                {connectButtonDisabled 
                  ? `⏱ Chờ ${3}s...` 
                  : '📡 Kết nối'}
              </button>
            </div>
          ) : (
            <div className="no-ports-message">
              <p>⏳ Chưa tìm thấy cổng COM. Hãy:</p>
              <ul>
                <li>✓ Cắm cáp USB vào Heltec module</li>
                <li>✓ Kiểm tra driver trong Device Manager</li>
                <li>✓ Chờ 2-3 giây để hệ thống nhận diện</li>
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default ConnectButton;
