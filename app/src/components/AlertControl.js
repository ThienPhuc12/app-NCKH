import { useState } from 'react';
import './AlertControl.css';

const ACK_TIMEOUT_MS = 10000;
const DELIVERY_WAIT_MS = 26000;

function createRequestId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `req-${Date.now()}`;
}

function ackVisual(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'delivered') {
    return { icon: '☁✓', label: 'DA NHAN', className: 'delivery delivered' };
  }
  if (normalized === 'pending') {
    return { icon: '☁…', label: 'DANG CHO ACK', className: 'delivery pending' };
  }
  if (normalized === 'failed') {
    return { icon: '☁!', label: 'THAT BAI', className: 'delivery failed' };
  }
  if (normalized === 'missed') {
    return { icon: '☁×', label: 'MISS', className: 'delivery missed' };
  }
  return { icon: '☁?', label: normalized.toUpperCase() || 'UNKNOWN', className: 'delivery unknown' };
}

function AlertControl({ gatewayUrl }) {
  const [targetId, setTargetId] = useState('^all');
  const [messageText, setMessageText] = useState('BAODONG');
  const [status, setStatus] = useState('San sang');
  const [lastResponse, setLastResponse] = useState('Chua co phan hoi');
  const [currentRequestId, setCurrentRequestId] = useState('');
  const [currentPacketId, setCurrentPacketId] = useState(null);
  const [deliveryByNode, setDeliveryByNode] = useState({});

  const handleSend = () => {
    const requestId = createRequestId();
    setCurrentRequestId(requestId);
    setCurrentPacketId(null);
    setDeliveryByNode({});
    setStatus('Dang ket noi gateway...');
    setLastResponse('Dang gui lenh...');

    const socket = new WebSocket(gatewayUrl);

    socket.onopen = () => {
      const payload = {
        version: '1.0',
        type: 'command',
        requestId,
        timestamp: new Date().toISOString(),
        command: 'BAODONG',
        payload: {
          text: messageText || 'BAODONG',
          targetId,
          source: 'alert-control-ui',
        },
      };

      socket.send(JSON.stringify(payload));
      setStatus('Da day lenh len gateway, dang cho ACK...');
    };

    const timeoutId = setTimeout(() => {
      setStatus('Khong nhan ACK tu gateway (timeout 10s)');
      setLastResponse('Khong nhan duoc ACK gateway cho request hien tai.');
      try {
        socket.close();
      } catch (_) {
        // no-op
      }
    }, ACK_TIMEOUT_MS);

    socket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);

        // Ignore periodic sync/update frames for this command socket.
        if (parsed.type === 'nodes:update' || parsed.type === 'NODE_UPDATE' || parsed.type === 'KEEP_ALIVE') {
          return;
        }

        const parsedRequestId = String(parsed.requestId || '');
        const isSameRequest = parsedRequestId && parsedRequestId === requestId;

        if (parsed.type === 'command:ack' && parsed.ok) {
          if (!isSameRequest) {
            return;
          }
          setCurrentPacketId(parsed.packetId ?? null);
          setStatus(`Gateway ACK: da gui den ${parsed.destination || 'unknown'}. Dang cho ACK delivery...`);
          if (parsed.destination && parsed.destination !== '^all') {
            setDeliveryByNode((prev) => ({
              ...prev,
              [String(parsed.destination)]: {
                nodeId: String(parsed.destination),
                nodeName: parsed.destinationName || String(parsed.destination),
                status: 'pending',
                reason: 'WAITING_ACK',
              },
            }));
          }
          setLastResponse(JSON.stringify(parsed, null, 2));
          return;
        }

        if (parsed.type === 'ack' && parsed.ok) {
          if (!isSameRequest) {
            return;
          }

          setCurrentPacketId(parsed.packetId ?? null);
          setStatus('Gui lenh thanh cong (ACK gateway da nhan), dang cho phan hoi node...');
          setLastResponse(JSON.stringify(parsed, null, 2));
          clearTimeout(timeoutId);

          setTimeout(() => {
            try {
              socket.close();
            } catch (_) {
              // no-op
            }
          }, DELIVERY_WAIT_MS);
          return;
        }

        if (parsed.type === 'mesh:ack') {
          if (parsed.requestId && String(parsed.requestId) !== String(currentPacketId ?? '')) {
            return;
          }
          const fromId = parsed.fromId || 'unknown';
          const reason = parsed.errorReason || 'NONE';
          setStatus(`Mesh ACK tu ${fromId} (status: ${reason})`);
          setLastResponse(JSON.stringify(parsed, null, 2));
          return;
        }

        if (parsed.type === 'command:delivery') {
          const byRequest = parsed.requestId && String(parsed.requestId) === requestId;
          const byPacket = currentPacketId != null && String(parsed.packetId) === String(currentPacketId);
          if (!byRequest && !byPacket) {
            return;
          }

          const status = String(parsed.status || 'unknown').toUpperCase();
          const destination = parsed.destination || 'unknown';
          const reason = parsed.errorReason || 'NONE';
          const destinationName = parsed.destinationName || String(destination);
          setDeliveryByNode((prev) => ({
            ...prev,
            [String(destination)]: {
              nodeId: String(destination),
              nodeName: destinationName,
              status: status.toLowerCase(),
              reason,
            },
          }));

          if (status === 'DELIVERED') {
            setStatus(`ACK DELIVERY: DEN NOI ${destination}`);
          } else if (status === 'FAILED') {
            setStatus(`ACK DELIVERY: THAT BAI (${reason})`);
          } else if (status === 'MISSED') {
            setStatus(`ACK DELIVERY: MISS/TIMEOUT (${reason})`);
          } else {
            setStatus(`ACK DELIVERY: ${status} (${reason})`);
          }
          setLastResponse(JSON.stringify(parsed, null, 2));
          return;
        }

        if (parsed.type === 'command:summary' && String(parsed.requestId || '') === requestId) {
          const entries = Array.isArray(parsed.destinations) ? parsed.destinations : [];
          const pendingMap = {};
          entries.forEach((entry) => {
            if (!entry?.id) {
              return;
            }
            pendingMap[String(entry.id)] = {
              nodeId: String(entry.id),
              nodeName: entry.name || String(entry.id),
              status: 'pending',
              reason: 'WAITING_ACK',
            };
          });
          setDeliveryByNode((prev) => ({ ...prev, ...pendingMap }));
          setLastResponse(JSON.stringify(parsed, null, 2));
          return;
        }

        if (parsed.type === 'mesh:receive') {
          const text = (parsed.text || '').trim();
          const fromId = parsed.fromId || 'unknown';
          const fromName = parsed.fromName || fromId;
          setDeliveryByNode((prev) => ({
            ...prev,
            [String(fromId)]: {
              nodeId: String(fromId),
              nodeName: fromName,
              status: 'delivered',
              reason: text ? 'TEXT_RESPONSE' : 'PACKET_RESPONSE',
            },
          }));
          setStatus(text ? `Nhan phan hoi tu ${fromId}: ${text}` : `Nhan packet phan hoi tu ${fromId}`);
          setLastResponse(JSON.stringify(parsed, null, 2));
          return;
        }

        if (parsed.type === 'error' || (parsed.type === 'STATUS' && parsed.status === 'error')) {
          setStatus(`Gateway bao loi: ${parsed.error || parsed.message || 'Khong ro'}`);
          setLastResponse(JSON.stringify(parsed, null, 2));
          clearTimeout(timeoutId);
          socket.close();
        }
      } catch (_err) {
        // Non-JSON response: ignore noisy text frames.
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
          placeholder="Vi du: ^all hoac !e3f9a120"
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
      {currentRequestId && <p className="status-line">Request ID: {currentRequestId}</p>}
      {currentPacketId != null && <p className="status-line">Packet ID: {currentPacketId}</p>}
      {targetId.trim().toLowerCase() === '^all' && (
        <p className="status-line">
          Dang dung fan-out theo node online de theo doi ACK delivery theo tung node.
        </p>
      )}
      {Object.keys(deliveryByNode).length > 0 && (
        <div className="status-line delivery-panel">
          <strong>Node da nhan/trang thai delivery:</strong>
          <ul className="delivery-list">
            {Object.values(deliveryByNode).map((item) => (
              <li key={item.nodeId} className="delivery-item">
                <span className={ackVisual(item.status).className}>{ackVisual(item.status).icon}</span>
                <span className="delivery-node">{item.nodeName} ({item.nodeId})</span>
                <span className="delivery-label">{ackVisual(item.status).label}</span>
                {item.reason ? <span className="delivery-reason">({item.reason})</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      <pre className="response-log">{lastResponse}</pre>
    </section>
  );
}

export default AlertControl;
