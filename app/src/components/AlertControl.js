import { useEffect, useMemo, useRef, useState } from 'react';
import './AlertControl.css';

const ACK_TIMEOUT_MS = 22000;
const EXCLUDED_NODE_SUFFIXES = new Set(['d4d4']);

function requestKeyCandidates(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) {
    return [];
  }

  const keys = [];
  const pushUnique = (candidate) => {
    if (!keys.includes(candidate)) {
      keys.push(candidate);
    }
  };

  pushUnique(text);
  if (text.startsWith('0x')) {
    const parsed = Number.parseInt(text, 16);
    if (Number.isFinite(parsed)) {
      pushUnique(String(parsed));
      pushUnique(parsed.toString(16));
      pushUnique(parsed.toString(16).padStart(8, '0'));
    }
    return keys;
  }

  if (/^[0-9]+$/.test(text)) {
    const parsed = Number.parseInt(text, 10);
    if (Number.isFinite(parsed)) {
      pushUnique(parsed.toString(16));
      pushUnique(parsed.toString(16).padStart(8, '0'));
    }
    return keys;
  }

  if (/^[0-9a-f]{8}$/.test(text)) {
    const parsed = Number.parseInt(text, 16);
    if (Number.isFinite(parsed)) {
      pushUnique(String(parsed));
    }
  }

  return keys;
}

function normalizeNodeId(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) {
    return '';
  }
  if (text.startsWith('!')) {
    return text;
  }
  if (/^[0-9a-f]{8}$/.test(text)) {
    return `!${text}`;
  }
  return text;
}

function isExcludedNodeId(value) {
  const normalized = normalizeNodeId(value);
  if (!normalized) {
    return false;
  }
  if (EXCLUDED_NODE_SUFFIXES.has(normalized)) {
    return true;
  }
  return normalized.startsWith('!') && EXCLUDED_NODE_SUFFIXES.has(normalized.slice(-4));
}

function createRequestId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `req-${Date.now()}`;
}

function ackVisual(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'delivered') {
    return { icon: '☁✓', label: 'ĐÃ NHẬN', className: 'delivery delivered' };
  }
  if (normalized === 'pending') {
    return { icon: '☁…', label: 'ĐANG GỬI/CHỜ ACK', className: 'delivery pending' };
  }
  if (normalized === 'failed') {
    return { icon: '☁!', label: 'THAT BAI', className: 'delivery failed' };
  }
  if (normalized === 'missed') {
    return { icon: '☁×', label: 'MISS', className: 'delivery missed' };
  }
  return { icon: '☁?', label: normalized.toUpperCase() || 'UNKNOWN', className: 'delivery unknown' };
}

function normalizeNode(rawNode) {
  const id = String(rawNode?.id || rawNode?.nodeId || rawNode?.device || '').trim();
  if (!id) {
    return null;
  }

  if (isExcludedNodeId(id)) {
    return null;
  }

  const name = String(
    rawNode?.name || rawNode?.longName || rawNode?.shortName || rawNode?.device || id,
  ).trim();
  const status = String(rawNode?.status || '').toLowerCase() === 'offline' ? 'offline' : 'online';

  return {
    id,
    name,
    status,
    type: String(rawNode?.type || '').toLowerCase() === 'gateway' ? 'gateway' : 'alarm',
    battery: Number.isFinite(Number(rawNode?.battery)) ? Number(rawNode.battery) : null,
    rssi: Number.isFinite(Number(rawNode?.rssi)) ? Number(rawNode.rssi) : null,
    lastSeen: rawNode?.lastSeen || rawNode?.last_seen || rawNode?.lastUpdated || '',
  };
}

function sortNodes(nodes) {
  return [...nodes].sort((a, b) => {
    const statusDiff = Number(a.status === 'offline') - Number(b.status === 'offline');
    if (statusDiff !== 0) {
      return statusDiff;
    }

    const nameDiff = a.name.localeCompare(b.name, 'vi');
    if (nameDiff !== 0) {
      return nameDiff;
    }

    return a.id.localeCompare(b.id);
  });
}

function AlertControl({ gatewayUrl }) {
  const [sendMode, setSendMode] = useState('dm');
  const [selectedChannel, setSelectedChannel] = useState(0);
  const [targetId, setTargetId] = useState('^all');
  const [messageText, setMessageText] = useState('BAODONG');
  const [status, setStatus] = useState('Sẵn sàng');
  const [lastResponse, setLastResponse] = useState('Chưa có phản hồi');
  const [currentRequestId, setCurrentRequestId] = useState('');
  const [currentPacketId, setCurrentPacketId] = useState(null);
  const [deliveryByNode, setDeliveryByNode] = useState({});
  const [availableNodes, setAvailableNodes] = useState([]);
  const [connectionState, setConnectionState] = useState('Đang kết nối gateway...');
  const [isConnected, setIsConnected] = useState(false);

  const socketRef = useRef(null);
  const sendTimeoutRef = useRef(null);
  const currentRequestIdRef = useRef('');
  const currentPacketIdRef = useRef(null);
  const availableNodesRef = useRef([]);

  const selectedNode = useMemo(
    () => availableNodes.find((node) => node.id === targetId) || null,
    [availableNodes, targetId],
  );

  const gatewayNode = useMemo(
    () => availableNodes.find((node) => node.type === 'gateway') || null,
    [availableNodes],
  );

  const selectableNodes = useMemo(
    () => availableNodes.filter((node) => node.type !== 'gateway'),
    [availableNodes],
  );

  const onlineNodes = useMemo(
    () => sortNodes(selectableNodes.filter((node) => node.status !== 'offline')),
    [selectableNodes],
  );

  const offlineNodes = useMemo(
    () => sortNodes(selectableNodes.filter((node) => node.status === 'offline')),
    [selectableNodes],
  );

  const selectedTargetLabel = useMemo(() => {
    if (sendMode === 'channel') {
      const channelNames = ['Primary', 'Secondary', 'Tertiary'];
      return `Chế độ Channel: ${channelNames[selectedChannel] || 'Unknown'}`;
    }
    if (targetId === '^all') {
      return 'Tất cả node (bao gồm cả node offline)';
    }
    return selectedNode ? `${selectedNode.name} (${selectedNode.id})` : targetId;
  }, [selectedNode, targetId, sendMode, selectedChannel]);

  useEffect(() => {
    availableNodesRef.current = availableNodes;
  }, [availableNodes]);

  useEffect(() => {
    const socket = new WebSocket(gatewayUrl);
    socketRef.current = socket;

    socket.onopen = () => {
      setConnectionState('Đã kết nối gateway');
      setIsConnected(true);
      socket.send(JSON.stringify({ type: 'GET_PORTS' }));
      socket.send(JSON.stringify({ type: 'sync' }));
    };

    socket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);

        if (parsed.type === 'PORT_LIST' || parsed.type === 'KEEP_ALIVE') {
          if (parsed.type === 'KEEP_ALIVE') {
            setIsConnected(parsed.status === 'connected');
            setConnectionState(
              parsed.status === 'connected'
                ? `Đã kết nối gateway: ${parsed.port || 'USB'}`
                : 'Đang tìm gateway / cổng COM... ',
            );
          }
          return;
        }

        if (parsed.type === 'CONNECTION_STATUS') {
          if (parsed.status === 'connected') {
            setIsConnected(true);
            setConnectionState(`Đã kết nối gateway: ${parsed.port || 'USB'}`);
          } else if (parsed.status === 'scanning') {
            setIsConnected(false);
            setConnectionState('Đang tìm cổng COM...');
          }
          return;
        }

        if (parsed.type === 'nodes:update') {
          const incoming = Array.isArray(parsed.nodes) ? parsed.nodes : [];
          const normalized = incoming.map(normalizeNode).filter(Boolean);
          setAvailableNodes(sortNodes(normalized));
          return;
        }

        if (parsed.type === 'NODE_UPDATE' && parsed.data) {
          const normalized = normalizeNode(parsed.data);
          if (!normalized) {
            return;
          }

          setAvailableNodes((current) => {
            const nextById = new Map(current.map((node) => [node.id, node]));
            nextById.set(normalized.id, normalized);
            return sortNodes(Array.from(nextById.values()));
          });
          return;
        }

        if (parsed.type === 'command:ack' && parsed.ok) {
          if (!parsed.requestId || parsed.requestId !== currentRequestIdRef.current) {
            return;
          }

          if (sendTimeoutRef.current) {
            clearTimeout(sendTimeoutRef.current);
            sendTimeoutRef.current = null;
          }

          setCurrentPacketId(parsed.packetId ?? null);
          currentPacketIdRef.current = parsed.packetId ?? null;
          setStatus(`Gateway ACK: đã gửi đến ${parsed.destination || 'unknown'}. Đang chờ ACK delivery...`);
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
          if (!parsed.requestId || parsed.requestId !== currentRequestIdRef.current) {
            return;
          }

          if (sendTimeoutRef.current) {
            clearTimeout(sendTimeoutRef.current);
            sendTimeoutRef.current = null;
          }

          setCurrentPacketId(parsed.packetId ?? null);
          currentPacketIdRef.current = parsed.packetId ?? null;
          setStatus('Gửi lệnh thành công (ACK gateway đã nhận), đang chờ phản hồi node...');
          setLastResponse(JSON.stringify(parsed, null, 2));
          return;
        }

        if (parsed.type === 'mesh:ack') {
          if (parsed.requestId && String(parsed.requestId) !== String(currentPacketIdRef.current ?? '')) {
            return;
          }
          const fromId = parsed.fromId || 'unknown';
          const reason = parsed.errorReason || 'NONE';
          setStatus(`Mesh ACK từ ${fromId} (status: ${reason})`);
          setLastResponse(JSON.stringify(parsed, null, 2));
          return;
        }

        if (parsed.type === 'command:delivery') {
          const byRequest = parsed.requestId && String(parsed.requestId) === currentRequestIdRef.current;
          const byPacket =
            currentPacketIdRef.current != null && String(parsed.packetId) === String(currentPacketIdRef.current);
          if (!byRequest && !byPacket) {
            return;
          }

          const deliveryStatus = String(parsed.status || 'unknown').toUpperCase();
          const destination = parsed.destination || 'unknown';
          if (isExcludedNodeId(destination)) {
            return;
          }
          const reason = parsed.errorReason || 'NONE';
          const destinationName = parsed.destinationName || String(destination);
          if (sendTimeoutRef.current) {
            clearTimeout(sendTimeoutRef.current);
            sendTimeoutRef.current = null;
          }
          setDeliveryByNode((prev) => ({
            ...prev,
            [String(destination)]: {
              nodeId: String(destination),
              nodeName: destinationName,
              status: deliveryStatus.toLowerCase(),
              reason,
            },
          }));

          if (deliveryStatus === 'DELIVERED') {
            setStatus(`ACK DELIVERY: ĐẾN NƠI ${destination}`);
          } else if (deliveryStatus === 'FAILED') {
            setStatus(`ACK DELIVERY: THẤT BẠI (${reason})`);
          } else if (deliveryStatus === 'MISSED') {
            setStatus(`ACK DELIVERY: MISS/TIMEOUT (${reason})`);
          } else {
            setStatus(`ACK DELIVERY: ${deliveryStatus} (${reason})`);
          }
          setLastResponse(JSON.stringify(parsed, null, 2));
          return;
        }

        if (parsed.type === 'command:summary' && String(parsed.requestId || '') === currentRequestIdRef.current) {
          const entries = Array.isArray(parsed.destinations) ? parsed.destinations : [];
          const attempted = Number.isFinite(Number(parsed.attempted)) ? Number(parsed.attempted) : entries.length;
          const sent = Number.isFinite(Number(parsed.sent)) ? Number(parsed.sent) : entries.length;
          const failed = Number.isFinite(Number(parsed.failed)) ? Number(parsed.failed) : Math.max(0, attempted - sent);
          const pendingMap = {};
          entries.forEach((entry) => {
            if (!entry?.id) {
              return;
            }
            if (isExcludedNodeId(entry.id)) {
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
          if (parsed.fanout) {
            setStatus(`Fan-out: đã gửi ${sent}/${attempted} node (thất bại gửi: ${failed}). Đang chờ ACK delivery...`);
          }
          setLastResponse(JSON.stringify(parsed, null, 2));
          return;
        }

        if (parsed.type === 'mesh:receive') {
          const text = (parsed.text || '').trim();
          const fromId = parsed.fromId || 'unknown';
          if (isExcludedNodeId(fromId)) {
            return;
          }
          const knownFrom = availableNodesRef.current.find((node) => node.id === String(fromId));
          if (knownFrom?.type === 'gateway') {
            return;
          }
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
          if (sendTimeoutRef.current) {
            clearTimeout(sendTimeoutRef.current);
            sendTimeoutRef.current = null;
          }
          setStatus(text ? `Nhận phản hồi từ ${fromId}: ${text}` : `Nhận packet phản hồi từ ${fromId}`);
          setLastResponse(JSON.stringify(parsed, null, 2));
          return;
        }

        if (parsed.type === 'error' || (parsed.type === 'STATUS' && parsed.status === 'error')) {
          setStatus(`Gateway báo lỗi: ${parsed.error || parsed.message || 'Không rõ'}`);
          setLastResponse(JSON.stringify(parsed, null, 2));
          setIsConnected(false);
          if (sendTimeoutRef.current) {
            clearTimeout(sendTimeoutRef.current);
            sendTimeoutRef.current = null;
          }
        }
      } catch (_err) {
        // Ignore non-JSON frames.
      }
    };

    socket.onerror = () => {
      setIsConnected(false);
      setConnectionState('Không kết nối được gateway.py');
      setStatus('Không kết nối được gateway.py');
    };

    socket.onclose = () => {
      setIsConnected(false);
      setConnectionState('WebSocket đã đóng. Mở lại app để kết nối lại.');
    };

    return () => {
      if (sendTimeoutRef.current) {
        clearTimeout(sendTimeoutRef.current);
      }
      try {
        socket.close();
      } catch (_) {
        // no-op
      }
      socketRef.current = null;
    };
  }, [gatewayUrl]);

  useEffect(() => {
    if (sendMode === 'channel') {
      const channelNames = ['Primary', 'Secondary', 'Tertiary'];
      setStatus(`Đang chọn channel: ${channelNames[selectedChannel] || 'Unknown'}`);
    } else if (targetId !== '^all' && selectedNode) {
      setStatus(`Đang chọn node: ${selectedNode.name} (${selectedNode.id})`);
    }
  }, [selectedNode, targetId, sendMode, selectedChannel]);

  useEffect(() => {
    if (targetId === '^all') {
      return;
    }
    const stillExists = selectableNodes.some((node) => node.id === targetId);
    if (!stillExists) {
      setTargetId('^all');
    }
  }, [selectableNodes, targetId]);

  const handleSelectNode = (nodeId) => {
    setTargetId(nodeId);
  };

  const handleSend = () => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setStatus('Gateway chưa sẵn sàng');
      return;
    }

    if (sendMode === 'dm' && !targetId.trim()) {
      setStatus('Hãy chọn node đích hoặc broadcast');
      return;
    }

    const requestId = createRequestId();
    currentRequestIdRef.current = requestId;
    setCurrentRequestId(requestId);
    setCurrentPacketId(null);
    currentPacketIdRef.current = null;
    setDeliveryByNode({});
    setStatus('Đang kết nối gateway...');
    setLastResponse('Đang gửi lệnh...');

    const finalTargetId = sendMode === 'channel' ? selectedChannel : targetId;
    const modeLabel = sendMode === 'channel' ? `Channel ${selectedChannel}` : `Node ${targetId}`;

    const payload = {
      version: '1.0',
      type: 'command',
      requestId,
      timestamp: new Date().toISOString(),
      command: 'BAODONG',
      payload: {
        text: messageText || 'BAODONG',
        targetId: finalTargetId,
        source: 'alert-control-ui',
        sendMode,
      },
    };

    socket.send(JSON.stringify(payload));
    setStatus(`Đã đẩy lệnh lên gateway (${modeLabel}), đang chờ ACK...`);

    if (sendTimeoutRef.current) {
      clearTimeout(sendTimeoutRef.current);
    }
    sendTimeoutRef.current = setTimeout(() => {
      setStatus('Không nhận phản hồi từ gateway (timeout)');
    }, ACK_TIMEOUT_MS);
  };

  return (
    <section className="alert-shell">
      <div className="gateway-banner">
        <div>
          <strong>{connectionState}</strong>
          <p>{selectedTargetLabel}</p>
          <p>
            Gateway node:{' '}
            {gatewayNode
              ? `${gatewayNode.name} (${gatewayNode.id}) | Pin ${
                  Number.isFinite(gatewayNode.battery) ? `${gatewayNode.battery}%` : 'N/A'
                }`
              : 'Chưa nhận được thông tin node gateway'}
          </p>
        </div>
        <button type="button" className={`gateway-pill ${isConnected ? 'connected' : 'disconnected'}`}>
          {isConnected ? 'Online' : 'Offline'}
        </button>
      </div>

      <div className="mode-selector-panel">
        <strong>Chế độ gửi</strong>
        <div className="mode-buttons">
          <button
            type="button"
            className={`mode-btn ${sendMode === 'dm' ? 'active' : ''}`}
            onClick={() => setSendMode('dm')}
          >
            📨 Gửi DM (Node riêng)
          </button>
          <button
            type="button"
            className={`mode-btn ${sendMode === 'channel' ? 'active' : ''}`}
            onClick={() => setSendMode('channel')}
          >
            📢 Gửi Channel
          </button>
        </div>
      </div>

      {sendMode === 'dm' && (
        <div className="node-picker-panel">
          <div className="node-picker-header">
            <div>
              <strong>Danh sách node đã kết nối (không gồm gateway)</strong>
              <p>Chọn node để gửi DM, hoặc chọn tất cả để broadcast.</p>
            </div>
            <button
              type="button"
              className={`node-chip broadcast ${targetId === '^all' ? 'active' : ''}`}
              onClick={() => handleSelectNode('^all')}
            >
              Tất cả
            </button>
          </div>

          <div className="node-picker-grid">
            {onlineNodes.map((node) => (
              <button
                key={node.id}
                type="button"
                className={`node-chip ${targetId === node.id ? 'active' : ''}`}
                onClick={() => handleSelectNode(node.id)}
              >
                <span className="node-chip-name">{node.name}</span>
                <span className="node-chip-id">{node.id}</span>
              </button>
            ))}
            {offlineNodes.map((node) => (
              <button
                key={node.id}
                type="button"
                className={`node-chip offline ${targetId === node.id ? 'active' : ''}`}
                onClick={() => handleSelectNode(node.id)}
              >
                <span className="node-chip-name">{node.name}</span>
                <span className="node-chip-id">{node.id}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {sendMode === 'channel' && (
        <div className="channel-picker-panel">
          <strong>Chọn channel</strong>
          <div className="channel-buttons">
            <button
              type="button"
              className={`channel-btn ${selectedChannel === 0 ? 'active' : ''}`}
              onClick={() => setSelectedChannel(0)}
            >
              Primary
            </button>
            <button
              type="button"
              className={`channel-btn ${selectedChannel === 1 ? 'active' : ''}`}
              onClick={() => setSelectedChannel(1)}
            >
              Secondary
            </button>
            <button
              type="button"
              className={`channel-btn ${selectedChannel === 2 ? 'active' : ''}`}
              onClick={() => setSelectedChannel(2)}
            >
              Tertiary
            </button>
          </div>
        </div>
      )}

      {sendMode === 'dm' && (
        <div className="field-group">
          <label htmlFor="targetId">Node đích</label>
          <input
            id="targetId"
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            placeholder="Ví dụ: ^all hoặc !e3f9a120"
          />
          <small>Chọn node trong danh sách bên trên hoặc nhập ID khác nếu cần.</small>
        </div>
      )}

      <div className="field-group">
        <label htmlFor="messageText">Nội dung cảnh báo</label>
        <select
          id="messageText"
          value={messageText}
          onChange={(event) => setMessageText(event.target.value)}
        >
          <option value="BAODONG">BAODONG</option>
          <option value="DUNGBAODONG">DUNGBAODONG</option>
          <option value="TEST">TEST</option>
        </select>
      </div>

      <button type="button" className="send-alert-btn" onClick={handleSend}>
        PHÁT LỆNH
      </button>

      <p className="status-line">Trạng thái: {status}</p>
      {currentRequestId && <p className="status-line">Request ID: {currentRequestId}</p>}
      {currentPacketId != null && <p className="status-line">Packet ID: {currentPacketId}</p>}
      {targetId.trim().toLowerCase() === '^all' && (
        <p className="status-line">
          Đang dùng fan-out theo tất cả node (online/offline) để theo dõi ACK delivery theo từng node.
        </p>
      )}
      {Object.keys(deliveryByNode).length > 0 && (
        <div className="status-line delivery-panel">
          <strong>Node đã nhận/trạng thái delivery:</strong>
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
