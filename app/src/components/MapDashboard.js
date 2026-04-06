import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, Popup, TileLayer } from 'react-leaflet';
import L from 'leaflet';
import { ToastContainer, toast } from 'react-toastify';
import 'leaflet/dist/leaflet.css';
import 'react-toastify/dist/ReactToastify.css';
import './MapDashboard.css';

const HYDRO_CENTER = [16.35, 107.5];

function sanitizeNode(node, previousNode) {
  const lastUpdated = node.lastUpdated || node.updatedAt || node.last_seen || new Date().toISOString();

  return {
    id: node.id,
    name: node.name || previousNode?.name || node.id,
    lat: Number(node.lat ?? previousNode?.lat ?? NaN),
    lng: Number(node.lng ?? previousNode?.lng ?? NaN),
    status: node.status === 'offline' ? 'offline' : 'online',
    type: node.type === 'gateway' ? 'gateway' : 'alarm',
    battery: Number.isFinite(node.battery)
      ? node.battery
      : Number.isFinite(previousNode?.battery)
      ? previousNode.battery
      : null,
    rssi: Number.isFinite(node.rssi)
      ? node.rssi
      : Number.isFinite(previousNode?.rssi)
      ? previousNode.rssi
      : null,
    lastUpdated,
    lastSeen: node.last_seen || previousNode?.lastSeen || formatLastUpdated(lastUpdated),
  };
}

function createNodeIcon(node) {
  const shortType = node.type === 'gateway' ? 'GW' : 'AL';
  return L.divIcon({
    className: 'node-marker-shell',
    html: `<div class="node-marker ${node.status} ${node.type}"><span>${shortType}</span></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -18],
  });
}

function mergeNodes(currentNodes, incomingNodes) {
  const nextById = new Map(currentNodes.map((node) => [node.id, node]));

  incomingNodes.forEach((rawNode) => {
    if (!rawNode?.id) {
      return;
    }

    const previous = nextById.get(rawNode.id);
    const merged = sanitizeNode(rawNode, previous);

    nextById.set(merged.id, merged);
  });

  return Array.from(nextById.values());
}

function getBatteryClass(battery) {
  if (!Number.isFinite(battery)) {
    return 'unknown';
  }
  if (battery > 50) {
    return 'good';
  }
  if (battery >= 20) {
    return 'medium';
  }
  return 'low';
}

function getSignalLevel(rssi) {
  if (!Number.isFinite(rssi)) {
    return 0;
  }
  if (rssi >= -80) {
    return 4;
  }
  if (rssi >= -95) {
    return 3;
  }
  if (rssi >= -105) {
    return 2;
  }
  return 1;
}

function SignalIcon({ rssi }) {
  const level = getSignalLevel(rssi);
  return (
    <span className="signal-icon" aria-label="RSSI">
      {[1, 2, 3, 4].map((bar) => (
        <span key={bar} className={`signal-bar ${bar <= level ? 'active' : ''}`} />
      ))}
    </span>
  );
}

function extractIncomingNodes(message) {
  if (Array.isArray(message)) {
    return message;
  }

  if (message?.type === 'NODE_UPDATE' && message?.data) {
    return [message.data];
  }

  if (Array.isArray(message?.nodes)) {
    return message.nodes;
  }

  if (message?.type === 'node:update' && message?.node) {
    return [message.node];
  }

  return null;
}

function isIncomingMeshMessage(message) {
  return message?.type === 'mesh:receive';
}

function isGatewayAck(message) {
  return message?.type === 'command:ack' || (message?.type === 'ack' && message?.ackSource === 'gateway');
}

function isMeshAck(message) {
  return message?.type === 'mesh:ack';
}

function isCommandDelivery(message) {
  return message?.type === 'command:delivery';
}

function formatLastUpdated(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Khong ro';
  }
  return date.toLocaleString('vi-VN');
}

function MapDashboard({ gatewayUrl }) {
  const [nodes, setNodes] = useState([]);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [socketState, setSocketState] = useState('Dang ket noi gateway...');
  const socketRef = useRef(null);
  const mapRef = useRef(null);
  const knownNodeIdsRef = useRef(new Set());
  const lowBatteryNotifiedRef = useRef(new Set());
  const useOfflineTiles = useMemo(() => process.env.REACT_APP_USE_OFFLINE_TILES === 'true', []);
  const activeNodes = useMemo(() => nodes.filter((node) => node.status === 'online'), [nodes]);
  const offlineNodes = useMemo(() => nodes.filter((node) => node.status !== 'online'), [nodes]);
  const mapNodes = useMemo(
    () => nodes.filter((node) => Number.isFinite(node.lat) && Number.isFinite(node.lng)),
    [nodes]
  );
  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) || activeNodes[0] || nodes[0] || null,
    [nodes, activeNodes, selectedNodeId]
  );

  const tileUrl = useMemo(() => {
    if (useOfflineTiles) {
      return `${process.env.PUBLIC_URL || '.'}/tiles/{z}/{x}/{y}.png`;
    }
    return 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  }, [useOfflineTiles]);

  const attribution = useMemo(() => {
    if (useOfflineTiles) {
      return 'Offline map tiles';
    }
    return '&copy; OpenStreetMap contributors';
  }, [useOfflineTiles]);

  useEffect(() => {
    const socket = new WebSocket(gatewayUrl);
    socketRef.current = socket;

    socket.onopen = () => {
      setSocketState('Da ket noi gateway.py');
      // Request current nodes from gateway
      console.log('[Frontend] Connected, requesting sync from gateway');
      socket.send(JSON.stringify({ type: 'sync' }));
    };

    socket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        console.log('[Frontend] Received message:', parsed);

        if (isGatewayAck(parsed)) {
          const dest = parsed.destination || 'unknown';
          toast.success(`ACK Gateway: da gui lenh den ${dest}`);
          return;
        }

        if (isMeshAck(parsed)) {
          const from = parsed.fromId || 'unknown';
          const reason = parsed.errorReason || 'NONE';
          toast.info(`ACK Mesh tu ${from} | status: ${reason}`);
          return;
        }

        if (isCommandDelivery(parsed)) {
          const status = String(parsed.status || 'unknown').toLowerCase();
          const destination = parsed.destination || 'unknown';
          const reason = parsed.errorReason || 'NONE';
          if (status === 'delivered') {
            toast.success(`Delivery OK: ${destination}`);
          } else if (status === 'failed') {
            toast.error(`Delivery FAIL: ${destination} (${reason})`);
          } else if (status === 'missed') {
            toast.warn(`Delivery MISS: ${destination} (timeout)`);
          } else {
            toast.info(`Delivery ${status}: ${destination} (${reason})`);
          }
          return;
        }

        if (isIncomingMeshMessage(parsed)) {
          const from = parsed.fromId || 'Unknown';
          const text = (parsed.text || '').trim();
          const signal = Number.isFinite(Number(parsed.rxRssi)) ? ` | RSSI ${parsed.rxRssi} dBm` : '';
          if (text) {
            toast.success(`Phan hoi tu ${from}: ${text}${signal}`);
          } else {
            toast.info(`Nhan packet tu ${from}${signal}`);
          }
          return;
        }
        
        const incomingNodes = extractIncomingNodes(parsed);
        if (!incomingNodes) {
          console.log('[Frontend] No nodes in message, skipping');
          return;
        }

        console.log('[Frontend] Processing nodes:', incomingNodes);
        incomingNodes.forEach((node) => {
          if (!node?.id) {
            return;
          }

          if (!knownNodeIdsRef.current.has(node.id)) {
            knownNodeIdsRef.current.add(node.id);
            console.log(`[Frontend] New node: ${node.name || node.id}`);
            toast.info(`Tram moi gia nhap Mesh: ${node.name || node.id}`);
          }

          const battery = Number(node.battery);
          if (Number.isFinite(battery) && battery < 15 && !lowBatteryNotifiedRef.current.has(node.id)) {
            lowBatteryNotifiedRef.current.add(node.id);
            toast.error(`Pin yeu duoi 15%: ${node.name || node.id}`);
          }

          if (Number.isFinite(battery) && battery >= 20 && lowBatteryNotifiedRef.current.has(node.id)) {
            lowBatteryNotifiedRef.current.delete(node.id);
          }
        });

        setNodes((current) => mergeNodes(current, incomingNodes));
      } catch (_error) {
        // Ignore non-JSON payloads from gateway ack/error frames.
      }
    };

    socket.onerror = () => {
      setSocketState('Mat ket noi WebSocket. Dang cho gateway.py...');
    };

    socket.onclose = () => {
      setSocketState('WebSocket da dong. Mo lai app de ket noi lai.');
    };

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [gatewayUrl]);

  useEffect(() => {
    if (!selectedNodeId && activeNodes[0]?.id) {
      setSelectedNodeId(activeNodes[0].id);
      return;
    }

    if (selectedNodeId && !nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(activeNodes[0]?.id || nodes[0]?.id || '');
    }
  }, [activeNodes, nodes, selectedNodeId]);

  function handleSelectNode(node) {
    if (!node?.id) {
      return;
    }

    setSelectedNodeId(node.id);

    if (mapRef.current && Number.isFinite(node.lat) && Number.isFinite(node.lng)) {
      mapRef.current.flyTo([node.lat, node.lng], Math.max(mapRef.current.getZoom(), 13), {
        duration: 0.8,
      });
    }
  }

  return (
    <section className="map-dashboard">
      <header className="map-header">
        <h2>Monitoring System - LoRa Mesh</h2>
        <p>{socketState}</p>
      </header>

      <div className="monitor-layout">
        <aside className="node-sidebar">
          <h3>Node Dang Hoat Dong</h3>

          {selectedNode && (
            <div className="selected-node-panel">
              <h4>Thong so node dang chon</h4>
              <p><strong>Ten:</strong> {selectedNode.name}</p>
              <p><strong>ID:</strong> {selectedNode.id}</p>
              <p><strong>Loai:</strong> {selectedNode.type === 'gateway' ? 'Gateway' : 'Node ngoai'}</p>
              <p><strong>Trang thai:</strong> {selectedNode.status === 'online' ? 'Online' : 'Offline'}</p>
              <p><strong>Pin:</strong> {Number.isFinite(selectedNode.battery) ? `${selectedNode.battery}%` : 'N/A'}</p>
              <p><strong>Tin hieu:</strong> {Number.isFinite(selectedNode.rssi) ? `${selectedNode.rssi} dBm` : 'N/A'}</p>
              <p><strong>Last seen:</strong> {selectedNode.lastSeen || formatLastUpdated(selectedNode.lastUpdated)}</p>
            </div>
          )}

          {activeNodes.length === 0 && <p className="empty-side">Chua co node online.</p>}

          {activeNodes.map((node) => {
            const batteryClass = getBatteryClass(node.battery);
            const batteryValue = Number.isFinite(node.battery) ? Math.max(0, Math.min(100, node.battery)) : 0;

            return (
              <button
                key={node.id}
                type="button"
                className={`node-row ${selectedNode?.id === node.id ? 'selected' : ''}`}
                onClick={() => handleSelectNode(node)}
              >
                <div className="node-row-head">
                  <strong>{node.name}</strong>
                  <span>{node.id}</span>
                </div>
                <div className="battery-track">
                  <div className={`battery-fill ${batteryClass}`} style={{ width: `${batteryValue}%` }} />
                </div>
                <div className="node-row-foot">
                  <span>Pin: {Number.isFinite(node.battery) ? `${node.battery}%` : 'N/A'}</span>
                  <span>Tin hieu: {Number.isFinite(node.rssi) ? `${node.rssi} dBm` : 'N/A'}</span>
                  <span>Last seen: {node.lastSeen || formatLastUpdated(node.lastUpdated)}</span>
                </div>
              </button>
            );
          })}

          <h3 className="offline-title">Node Da Mat Ket Noi</h3>
          {offlineNodes.length === 0 && <p className="empty-side">Khong co node offline.</p>}
          {offlineNodes.map((node) => {
            const batteryClass = getBatteryClass(node.battery);
            const batteryValue = Number.isFinite(node.battery) ? Math.max(0, Math.min(100, node.battery)) : 0;

            return (
              <button
                key={node.id}
                type="button"
                className={`node-row offline ${selectedNode?.id === node.id ? 'selected' : ''}`}
                onClick={() => handleSelectNode(node)}
              >
                <div className="node-row-head">
                  <strong>{node.name}</strong>
                  <span>{node.id}</span>
                </div>
                <div className="battery-track">
                  <div className={`battery-fill ${batteryClass}`} style={{ width: `${batteryValue}%` }} />
                </div>
                <div className="node-row-foot">
                  <span>Pin: {Number.isFinite(node.battery) ? `${node.battery}%` : 'N/A'}</span>
                  <span>Tin hieu: {Number.isFinite(node.rssi) ? `${node.rssi} dBm` : 'N/A'}</span>
                  <span>Last seen: {node.lastSeen || formatLastUpdated(node.lastUpdated)}</span>
                </div>
              </button>
            );
          })}
        </aside>

        <div className="map-shell">
          <MapContainer
            center={HYDRO_CENTER}
            zoom={12}
            className="leaflet-map"
            scrollWheelZoom
            whenCreated={(map) => {
              mapRef.current = map;
            }}
          >
            <TileLayer url={tileUrl} attribution={attribution} />

            {mapNodes.map((node) => (
              <Marker
                key={node.id}
                position={[node.lat, node.lng]}
                icon={createNodeIcon(node)}
                eventHandlers={{
                  click: () => handleSelectNode(node),
                }}
              >
                <Popup>
                  <div className="popup-content">
                    <h3>{node.name}</h3>
                    <p>ID: {node.id}</p>
                    <p>Loai tram: {node.type === 'gateway' ? 'Tram dieu hanh' : 'Tram coi hu'}</p>
                    <p className="rssi-line">
                      <SignalIcon rssi={node.rssi} /> RSSI: {Number.isFinite(node.rssi) ? `${node.rssi} dBm` : 'N/A'}
                    </p>
                    <p>Pin: {Number.isFinite(node.battery) ? `${node.battery}%` : 'Chua co du lieu'}</p>
                    <p>Last seen: {node.lastSeen || formatLastUpdated(node.lastUpdated)}</p>
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
      </div>

      {nodes.length === 0 && (
        <p className="empty-note">
          Chua nhan duoc node nao tu gateway.py. Ban do se cap nhat ngay khi co du lieu that.
        </p>
      )}

      <div className="legend-row">
        <span className="legend-item online">Online</span>
        <span className="legend-item offline">Offline (nhap nhay)</span>
        <span className="legend-item gateway">Gateway</span>
        <span className="legend-item alarm">Alarm</span>
      </div>

      <ToastContainer position="top-right" autoClose={3500} newestOnTop closeOnClick theme="dark" />
    </section>
  );
}

export default MapDashboard;