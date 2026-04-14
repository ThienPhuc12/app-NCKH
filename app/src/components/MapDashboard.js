import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AttributionControl,
  Map as MapView,
  Marker,
  NavigationControl,
  Popup,
  ScaleControl,
} from 'react-map-gl/maplibre';
import { ToastContainer, toast } from 'react-toastify';
import 'maplibre-gl/dist/maplibre-gl.css';
import 'react-toastify/dist/ReactToastify.css';
import './MapDashboard.css';

const DEFAULT_CENTER = [16.35, 107.5];
const DEFAULT_ZOOM = 11;
const FALLBACK_MAP_STYLE = {
  version: 8,
  sources: {
    cartoRaster: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution:
        '&copy; OpenStreetMap contributors &copy; CARTO',
      maxzoom: 20,
    },
  },
  layers: [
    {
      id: 'carto-base',
      type: 'raster',
      source: 'cartoRaster',
      minzoom: 0,
      maxzoom: 20,
    },
  ],
};
const MAP_STYLE = process.env.REACT_APP_MAP_STYLE_URL || FALLBACK_MAP_STYLE;
const NOTIFICATION_WINDOW_MS = 60 * 1000;
const MAX_NOTIFICATIONS = 80;
const EXCLUDED_NODE_SUFFIXES = new Set(['d4d4']);

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

function normalizeNode(node, previousNode) {
  if (isExcludedNodeId(node?.id)) {
    return null;
  }

  const lat = Number(node.lat ?? previousNode?.lat ?? Number.NaN);
  const lng = Number(node.lng ?? previousNode?.lng ?? Number.NaN);
  const lastUpdated = node.lastUpdated || node.updatedAt || node.last_seen || new Date().toISOString();

  return {
    id: String(node.id),
    name: node.name || previousNode?.name || String(node.id),
    lat,
    lng,
    status: node.status === 'offline' ? 'offline' : 'online',
    type: node.type === 'gateway' ? 'gateway' : 'alarm',
    battery: Number.isFinite(Number(node.battery))
      ? Number(node.battery)
      : Number.isFinite(previousNode?.battery)
        ? previousNode.battery
        : null,
    rssi: Number.isFinite(Number(node.rssi))
      ? Number(node.rssi)
      : Number.isFinite(previousNode?.rssi)
        ? previousNode.rssi
        : null,
    lastUpdated,
    lastSeen: node.last_seen || previousNode?.lastSeen || formatLastUpdated(lastUpdated),
  };
}

function mergeNodes(currentNodes, incomingNodes) {
  const nextById = new Map(currentNodes.map((node) => [node.id, node]));

  incomingNodes.forEach((rawNode) => {
    if (!rawNode?.id) {
      return;
    }
    if (isExcludedNodeId(rawNode.id)) {
      nextById.delete(String(rawNode.id));
      return;
    }

    const previous = nextById.get(String(rawNode.id));
    const merged = normalizeNode(rawNode, previous);
    if (merged) {
      nextById.set(merged.id, merged);
    }
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

function createNodeMarkerClass(node) {
  return ['map-marker', node.status, node.type].join(' ');
}

function formatTimeAgo(timestamp) {
  const diffMs = Date.now() - Number(timestamp || 0);
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return 'vua xong';
  }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 10) {
    return 'vua xong';
  }
  if (seconds < 60) {
    return `${seconds}s truoc`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}p truoc`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h truoc`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d truoc`;
}

function MapDashboard({ gatewayUrl }) {
  const [nodes, setNodes] = useState([]);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [socketState, setSocketState] = useState('Dang ket noi gateway...');
  const socketRef = useRef(null);
  const mapRef = useRef(null);
  const knownNodeIdsRef = useRef(new Set());
  const lowBatteryNotifiedRef = useRef(new Set());
  const hasFitBoundsOnce = useRef(false);
  const notificationSeqRef = useRef(0);
  const [notifications, setNotifications] = useState([]);
  const [notificationFilter, setNotificationFilter] = useState('all');
  const [isNotificationPanelOpen, setIsNotificationPanelOpen] = useState(false);

  const activeNodes = useMemo(() => nodes.filter((node) => node.status === 'online'), [nodes]);
  const offlineNodes = useMemo(() => nodes.filter((node) => node.status !== 'online'), [nodes]);
  const mapNodes = useMemo(
    () => nodes.filter((node) => Number.isFinite(node.lat) && Number.isFinite(node.lng)),
    [nodes],
  );
  const selectedNode = useMemo(() => {
    return nodes.find((node) => node.id === selectedNodeId) || activeNodes[0] || nodes[0] || null;
  }, [nodes, activeNodes, selectedNodeId]);
  const unreadCount = useMemo(() => notifications.filter((item) => !item.read).length, [notifications]);
  const filteredNotifications = useMemo(() => {
    if (notificationFilter === 'all') {
      return notifications;
    }
    return notifications.filter((item) => item.level === notificationFilter);
  }, [notifications, notificationFilter]);

  const selectedNodeHasPosition = Boolean(
    selectedNode && Number.isFinite(selectedNode.lat) && Number.isFinite(selectedNode.lng),
  );

  const pushNotification = useCallback(({
    dedupeKey,
    title,
    detail,
    level = 'info',
    shouldToast = false,
    toastType = 'info',
  }) => {
    const now = Date.now();
    const stableKey = String(dedupeKey || title || 'event');

    setNotifications((current) => {
      const index = current.findIndex(
        (item) => item.dedupeKey === stableKey && now - item.lastSeenAt <= NOTIFICATION_WINDOW_MS,
      );

      if (index >= 0) {
        const updated = [...current];
        const previous = updated[index];
        updated[index] = {
          ...previous,
          title,
          detail,
          level,
          count: previous.count + 1,
          read: false,
          lastSeenAt: now,
        };

        if (index > 0) {
          const [latest] = updated.splice(index, 1);
          updated.unshift(latest);
        }
        return updated;
      }

      notificationSeqRef.current += 1;
      const nextItem = {
        id: `n-${notificationSeqRef.current}`,
        dedupeKey: stableKey,
        title,
        detail,
        level,
        count: 1,
        read: false,
        lastSeenAt: now,
      };

      return [nextItem, ...current].slice(0, MAX_NOTIFICATIONS);
    });

    if (shouldToast) {
      const toastId = `t-${stableKey}`;
      const message = `${title}${detail ? `: ${detail}` : ''}`;
      if (toastType === 'error') {
        toast.error(message, { toastId });
      } else if (toastType === 'warn') {
        toast.warn(message, { toastId });
      } else if (toastType === 'success') {
        toast.success(message, { toastId });
      } else {
        toast.info(message, { toastId });
      }
    }
  }, []);

  function markAllNotificationsRead() {
    setNotifications((current) => current.map((item) => ({ ...item, read: true })));
  }

  function markNotificationRead(id) {
    setNotifications((current) =>
      current.map((item) => (item.id === id ? { ...item, read: true } : item)),
    );
  }

  useEffect(() => {
    const socket = new WebSocket(gatewayUrl);
    socketRef.current = socket;

    socket.onopen = () => {
      setSocketState('Da ket noi gateway.py');
      pushNotification({
        dedupeKey: 'ws-connected',
        title: 'Gateway da ket noi',
        detail: 'Kenh WebSocket san sang.',
        level: 'info',
      });
      socket.send(JSON.stringify({ type: 'sync' }));
    };

    socket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);

        if (isGatewayAck(parsed)) {
          const dest = parsed.destination || 'unknown';
          pushNotification({
            dedupeKey: `gateway-ack-${dest}`,
            title: 'Gateway ACK',
            detail: `Da gui lenh den ${dest}`,
            level: 'info',
          });
          return;
        }

        if (isMeshAck(parsed)) {
          const from = parsed.fromId || 'unknown';
          const reason = parsed.errorReason || 'NONE';
          pushNotification({
            dedupeKey: `mesh-ack-${from}-${reason}`,
            title: `ACK Mesh tu ${from}`,
            detail: `Trang thai: ${reason}`,
            level: reason === 'NONE' ? 'info' : 'critical',
            shouldToast: reason !== 'NONE',
            toastType: reason === 'NONE' ? 'info' : 'warn',
          });
          return;
        }

        if (isCommandDelivery(parsed)) {
          const status = String(parsed.status || 'unknown').toLowerCase();
          const destination = parsed.destination || 'unknown';
          const reason = parsed.errorReason || 'NONE';
          if (status === 'delivered') {
            pushNotification({
              dedupeKey: `delivery-ok-${destination}`,
              title: `Delivery OK: ${destination}`,
              detail: 'Lenh da duoc node tiep nhan.',
              level: 'info',
            });
          } else if (status === 'failed') {
            pushNotification({
              dedupeKey: `delivery-failed-${destination}-${reason}`,
              title: `Delivery FAIL: ${destination}`,
              detail: reason,
              level: 'critical',
              shouldToast: true,
              toastType: 'error',
            });
          } else if (status === 'missed') {
            pushNotification({
              dedupeKey: `delivery-missed-${destination}`,
              title: `Delivery MISS: ${destination}`,
              detail: 'Timeout ACK.',
              level: 'critical',
              shouldToast: true,
              toastType: 'warn',
            });
          } else {
            pushNotification({
              dedupeKey: `delivery-${status}-${destination}`,
              title: `Delivery ${status}: ${destination}`,
              detail: reason,
              level: 'info',
            });
          }
          return;
        }

        if (isIncomingMeshMessage(parsed)) {
          const from = parsed.fromId || 'Unknown';
          if (isExcludedNodeId(from)) {
            return;
          }
          const text = (parsed.text || '').trim();
          const signal = Number.isFinite(Number(parsed.rxRssi)) ? ` | RSSI ${parsed.rxRssi} dBm` : '';
          pushNotification({
            dedupeKey: `mesh-receive-${from}`,
            title: text ? `Phan hoi tu ${from}` : `Nhan packet tu ${from}`,
            detail: text ? `${text}${signal}` : signal || 'Packet khong co text',
            level: 'info',
          });
          return;
        }

        const incomingNodes = extractIncomingNodes(parsed);
        if (!incomingNodes) {
          return;
        }

        const filteredIncomingNodes = incomingNodes.filter((node) => !isExcludedNodeId(node?.id));

        if (parsed.type === 'nodes:update') {
          const snapshotNodes = filteredIncomingNodes
            .map((node) => normalizeNode(node, undefined))
            .filter(Boolean);
          setNodes(snapshotNodes);
          return;
        }

        const joinedNames = [];
        filteredIncomingNodes.forEach((node) => {
          if (!node?.id) {
            return;
          }

          if (!knownNodeIdsRef.current.has(node.id)) {
            knownNodeIdsRef.current.add(node.id);
            joinedNames.push(node.name || node.id);
          }

          const battery = Number(node.battery);
          if (Number.isFinite(battery) && battery < 15 && !lowBatteryNotifiedRef.current.has(node.id)) {
            lowBatteryNotifiedRef.current.add(node.id);
            pushNotification({
              dedupeKey: `low-battery-${node.id}`,
              title: 'Pin yeu duoi 15%',
              detail: node.name || node.id,
              level: 'critical',
              shouldToast: true,
              toastType: 'error',
            });
          }

          if (Number.isFinite(battery) && battery >= 20 && lowBatteryNotifiedRef.current.has(node.id)) {
            lowBatteryNotifiedRef.current.delete(node.id);
          }
        });

        if (joinedNames.length > 0) {
          const preview = joinedNames.slice(0, 3).join(', ');
          const moreCount = joinedNames.length - 3;
          pushNotification({
            dedupeKey: 'nodes-joined',
            title: joinedNames.length > 1 ? `${joinedNames.length} tram moi gia nhap` : 'Tram moi gia nhap',
            detail: moreCount > 0 ? `${preview} +${moreCount}` : preview,
            level: 'info',
          });
        }

        setNodes((current) => mergeNodes(current, filteredIncomingNodes));
      } catch (_error) {
        // Ignore non-JSON payloads from gateway ack/error frames.
      }
    };

    socket.onerror = () => {
      setSocketState('Mat ket noi WebSocket. Dang cho gateway.py...');
      pushNotification({
        dedupeKey: 'ws-error',
        title: 'Mat ket noi gateway',
        detail: 'Dang thu ket noi lai WebSocket.',
        level: 'critical',
        shouldToast: true,
        toastType: 'warn',
      });
    };

    socket.onclose = () => {
      setSocketState('WebSocket da dong. Mo lai app de ket noi lai.');
      pushNotification({
        dedupeKey: 'ws-closed',
        title: 'WebSocket da dong',
        detail: 'Can khoi dong lai app hoac gateway.',
        level: 'critical',
        shouldToast: true,
        toastType: 'error',
      });
    };

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [gatewayUrl, pushNotification]);

  useEffect(() => {
    if (!selectedNodeId && activeNodes[0]?.id) {
      setSelectedNodeId(activeNodes[0].id);
      return;
    }

    if (selectedNodeId && !nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(activeNodes[0]?.id || nodes[0]?.id || '');
    }
  }, [activeNodes, nodes, selectedNodeId]);

  useEffect(() => {
    if (!mapRef.current || !mapNodes.length || hasFitBoundsOnce.current) {
      return;
    }

    const bounds = mapNodes.reduce(
      (acc, node) => {
        acc.minLng = Math.min(acc.minLng, node.lng);
        acc.maxLng = Math.max(acc.maxLng, node.lng);
        acc.minLat = Math.min(acc.minLat, node.lat);
        acc.maxLat = Math.max(acc.maxLat, node.lat);
        return acc;
      },
      { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity },
    );

    if (Number.isFinite(bounds.minLng) && Number.isFinite(bounds.minLat)) {
      try {
        mapRef.current.fitBounds(
          [
            [bounds.minLng, bounds.minLat],
            [bounds.maxLng, bounds.maxLat],
          ],
          {
            padding: 72,
            duration: 800,
            maxZoom: 15,
          },
        );
        hasFitBoundsOnce.current = true;
      } catch (_error) {
        // Ignore fit errors; the map still renders with default center.
      }
    }
  }, [mapNodes]);

  function handleSelectNode(node) {
    if (!node?.id) {
      return;
    }

    setSelectedNodeId(node.id);

    if (mapRef.current && Number.isFinite(node.lat) && Number.isFinite(node.lng)) {
      try {
        mapRef.current.flyTo({
          center: [node.lng, node.lat],
          zoom: Math.max(mapRef.current.getZoom(), 13),
          duration: 800,
        });
      } catch (_error) {
        // Ignore fly errors.
      }
    }
  }

  return (
    <section className="map-dashboard">
      <header className="map-header">
        <div>
          <h2>Monitoring System - LoRa Mesh</h2>
          <p>{socketState}</p>
        </div>
        <div className="notice-actions">
          <button
            type="button"
            className={`notice-toggle ${isNotificationPanelOpen ? 'active' : ''}`}
            onClick={() => {
              setIsNotificationPanelOpen((open) => {
                const next = !open;
                if (next) {
                  markAllNotificationsRead();
                }
                return next;
              });
            }}
          >
            Thong bao
            {unreadCount > 0 && <span className="notice-badge">{unreadCount}</span>}
          </button>
        </div>
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
          <MapView
            ref={mapRef}
            initialViewState={{
              longitude: DEFAULT_CENTER[1],
              latitude: DEFAULT_CENTER[0],
              zoom: DEFAULT_ZOOM,
            }}
            mapStyle={MAP_STYLE}
            className="map-canvas"
            attributionControl={false}
            renderWorldCopies={false}
            maxPitch={0}
            dragRotate={false}
            touchZoomRotate={false}
            onClick={() => {
              if (!selectedNodeHasPosition && mapNodes.length > 0) {
                setSelectedNodeId(mapNodes[0].id);
              }
            }}
          >
            <AttributionControl compact={false} />
            <NavigationControl position="top-right" showCompass={false} />
            <ScaleControl />

            {mapNodes.map((node) => (
              <Marker
                key={node.id}
                longitude={node.lng}
                latitude={node.lat}
                anchor="center"
                onClick={(event) => {
                  event.originalEvent.stopPropagation();
                  handleSelectNode(node);
                }}
              >
                <button type="button" className={createNodeMarkerClass(node)} aria-label={node.name}>
                  <span>{node.type === 'gateway' ? 'GW' : 'AL'}</span>
                </button>
              </Marker>
            ))}

            {selectedNodeHasPosition && selectedNode && (
              <Popup
                longitude={selectedNode.lng}
                latitude={selectedNode.lat}
                anchor="top"
                onClose={() => setSelectedNodeId('')}
                closeOnClick={false}
                maxWidth="280px"
              >
                <div className="popup-content">
                  <h3>{selectedNode.name}</h3>
                  <p>ID: {selectedNode.id}</p>
                  <p>Loai tram: {selectedNode.type === 'gateway' ? 'Tram dieu hanh' : 'Tram coi hu'}</p>
                  <p className="rssi-line">
                    <SignalIcon rssi={selectedNode.rssi} /> RSSI: {Number.isFinite(selectedNode.rssi) ? `${selectedNode.rssi} dBm` : 'N/A'}
                  </p>
                  <p>Pin: {Number.isFinite(selectedNode.battery) ? `${selectedNode.battery}%` : 'Chua co du lieu'}</p>
                  <p>Last seen: {selectedNode.lastSeen || formatLastUpdated(selectedNode.lastUpdated)}</p>
                </div>
              </Popup>
            )}
          </MapView>
        </div>
      </div>

      {nodes.length === 0 && (
        <p className="empty-note">
          Chua nhan duoc node nao tu gateway.py. Ban do se cap nhat ngay khi co du lieu that.
        </p>
      )}

      <div className="legend-row">
        <span className="legend-item online">Online</span>
        <span className="legend-item offline">Offline</span>
        <span className="legend-item gateway">Gateway</span>
        <span className="legend-item alarm">Alarm</span>
      </div>

      <aside className={`notification-panel ${isNotificationPanelOpen ? 'open' : ''}`}>
        <div className="notification-head">
          <h3>Notification Center</h3>
          <button type="button" onClick={markAllNotificationsRead}>Doc tat ca</button>
        </div>

        <div className="notification-tabs">
          {[
            { id: 'all', label: 'Tat ca' },
            { id: 'critical', label: 'Canh bao' },
            { id: 'info', label: 'Thong tin' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={notificationFilter === tab.id ? 'active' : ''}
              onClick={() => setNotificationFilter(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="notification-list">
          {filteredNotifications.length === 0 && <p className="notification-empty">Chua co thong bao.</p>}
          {filteredNotifications.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`notification-item ${item.level} ${item.read ? 'read' : 'unread'}`}
              onClick={() => markNotificationRead(item.id)}
            >
              <div className="notification-item-head">
                <strong>{item.title}</strong>
                <span>{formatTimeAgo(item.lastSeenAt)}</span>
              </div>
              <p>{item.detail}</p>
              {item.count > 1 && <small>Lap lai {item.count} lan</small>}
            </button>
          ))}
        </div>
      </aside>

      <ToastContainer
        position="top-right"
        autoClose={3200}
        newestOnTop
        closeOnClick
        pauseOnHover
        theme="dark"
        limit={2}
        hideProgressBar
        toastClassName="mesh-toast"
      />
    </section>
  );
}

export default MapDashboard;
