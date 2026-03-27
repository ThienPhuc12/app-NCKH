import { useState } from 'react';
import './AlertControl.css';

function createRequestId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `req-${Date.now()}`;
}

function AlertControl({ gatewayUrl }) {
  const [targetId, setTargetId] = useState('Node_1');
  const [messageText, setMessageText] = useState('BAODONG');
  const [status, setStatus] = useState('San sang');
  const [lastResponse, setLastResponse] = useState('Chua co phan hoi');

  const handleSend = () => {
    setStatus('Dang ket noi gateway...');
    const socket = new WebSocket(gatewayUrl);

    socket.onopen = () => {
      const payload = {
        version: '1.0',
        type: 'command',
        requestId: createRequestId(),
        timestamp: new Date().toISOString(),
        command: 'BAODONG',
        payload: {
          text: messageText || 'BAODONG',
          targetId,
          source: 'alert-control-ui',
        },
      };

      socket.send(JSON.stringify(payload));
      setStatus('Da gui lenh BAODONG');
    };

    const timeoutId = setTimeout(() => {
      setStatus('Khong nhan ACK tu gateway (timeout 10s)');
      try {
        socket.close();
      } catch (_) {
        // no-op
      }
    }, 10000);

    socket.onmessage = (event) => {
      setLastResponse(event.data);

      try {
        const parsed = JSON.parse(event.data);

        // Ignore periodic sync/update frames for this command socket.
        if (parsed.type === 'nodes:update' || parsed.type === 'NODE_UPDATE' || parsed.type === 'KEEP_ALIVE') {
          return;
        }

        if (parsed.type === 'ack' && parsed.ok) {
          setStatus('Gui lenh thanh cong (ACK da nhan)');
          clearTimeout(timeoutId);
          socket.close();
          return;
        }

        if (parsed.type === 'error' || (parsed.type === 'STATUS' && parsed.status === 'error')) {
          setStatus(`Gateway bao loi: ${parsed.error || parsed.message || 'Khong ro'}`);
          clearTimeout(timeoutId);
          socket.close();
        }
      } catch (_err) {
        // Non-JSON response: keep waiting for ACK until timeout.
      }
    };

    socket.onerror = () => {
      clearTimeout(timeoutId);
      setStatus('Khong ket noi duoc gateway.py');
    };

    socket.onclose = () => {
      clearTimeout(timeoutId);
    };
  };

  return (
    <section className="alert-shell">
      <div className="field-group">
        <label htmlFor="targetId">Node dich</label>
        <input
          id="targetId"
          value={targetId}
          onChange={(event) => setTargetId(event.target.value)}
          placeholder="Vi du: Node_1"
        />
      </div>

      <div className="field-group">
        <label htmlFor="messageText">Noi dung canh bao</label>
        <input
          id="messageText"
          value={messageText}
          onChange={(event) => setMessageText(event.target.value)}
          placeholder="Vi du: BAODONG"
        />
      </div>

      <button type="button" className="send-alert-btn" onClick={handleSend}>
        PHAT LENH
      </button>

      <p className="status-line">Trang thai: {status}</p>
      <pre className="response-log">{lastResponse}</pre>
    </section>
  );
}

export default AlertControl;
