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
import SettingsDrawer from './SettingsDrawer';
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
const DEFAULT_DASHBOARD_SETTINGS = {
  radio: {},
  lora: {},
  power: {},
  display: {},
  bluetooth: {},
  position: {},
  device: {},
  module: {},
  connections: {},
};

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
    return 'Không rõ';
  }
  return date.toLocaleString('vi-VN');
}

function createNodeMarkerClass(node) {
  return ['map-marker', node.status, node.type].join(' ');
}

function formatTimeAgo(timestamp) {
  const diffMs = Date.now() - Number(timestamp || 0);
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return 'vừa xong';
  }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 10) {
    return 'vừa xong';
  }
  if (seconds < 60) {
    return `${seconds}s trước`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}p trước`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h trước`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d trước`;
}

function MapDashboard({ gatewayUrl }) {
  const [nodes, setNodes] = useState([]);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [socketState, setSocketState] = useState('Đang kết nối gateway...');
  const socketRef = useRef(null);
  const mapRef = useRef(null);
  const knownNodeIdsRef = useRef(new Set());
  const lowBatteryNotifiedRef = useRef(new Set());
  const hasFitBoundsOnce = useRef(false);
  const notificationSeqRef = useRef(0);
  const [notifications, setNotifications] = useState([]);
  const [notificationFilter, setNotificationFilter] = useState('all');
  const [isNotificationPanelOpen, setIsNotificationPanelOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [socketReady, setSocketReady] = useState(false);
  const [settingsData, setSettingsData] = useState(DEFAULT_DASHBOARD_SETTINGS);
  const [fixedLocations, setFixedLocations] = useState({});
  const [isLocationSetMode, setIsLocationSetMode] = useState(false);
  const [locationDraft, setLocationDraft] = useState(null);

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
  const localNode = useMemo(() => nodes.find((node) => node.type === 'gateway') || null, [nodes]);
  const localFixedLocation = useMemo(() => {
    if (!localNode?.id) {
      return null;
    }
    return fixedLocations[localNode.id] || null;
  }, [fixedLocations, localNode]);
  const localNodePosition = useMemo(() => {
    if (!localNode || !Number.isFinite(localNode.lat) || !Number.isFinite(localNode.lng)) {
      return null;
    }
    return {
      lat: localNode.lat,
      lng: localNode.lng,
    };
  }, [localNode]);

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

  const sendGatewayMessage = useCallback((payload) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      pushNotification({
        dedupeKey: 'gateway-send-unavailable',
        title: 'Gateway chưa sẵn sàng',
        detail: 'Không thể gửi lệnh khi WebSocket chưa kết nối.',
        level: 'critical',
      });
      return false;
    }
    socket.send(JSON.stringify(payload));
    return true;
  }, [pushNotification]);

  const handleLocationAction = useCallback((action) => {
    if (action === 'beginSet') {
      const baseline = localFixedLocation || localNodePosition || null;
      setLocationDraft(
        baseline && Number.isFinite(Number(baseline.lat)) && Number.isFinite(Number(baseline.lng))
          ? { lat: Number(baseline.lat), lng: Number(baseline.lng) }
          : null,
      );
      setIsLocationSetMode(true);
      pushNotification({
        dedupeKey: 'location-set-mode',
        title: 'Đang chọn vị trí local node',
        detail: 'Click lên map để chọn tọa độ, sau đó mở Cài đặt > Location để lưu.',
        level: 'info',
      });
      return;
    }

    if (action === 'cancelSet') {
      setIsLocationSetMode(false);
      setLocationDraft(null);
      return;
    }

    if (action === 'save') {
      if (!localNode?.id || !locationDraft) {
        pushNotification({
          dedupeKey: 'location-save-missing',
          title: 'Chưa có dữ liệu để lưu',
          detail: 'Cần node local và điểm đã chọn trên map.',
          level: 'critical',
          shouldToast: true,
          toastType: 'warn',
        });
        return;
      }
      const sent = sendGatewayMessage({
        type: 'location:set',
        nodeId: localNode.id,
        lat: Number(locationDraft.lat),
        lng: Number(locationDraft.lng),
        name: localNode.name || localNode.id,
      });
      if (sent) {
        setIsLocationSetMode(false);
      }
      return;
    }

    if (action === 'clear') {
      if (!localNode?.id) {
        return;
      }
      sendGatewayMessage({
        type: 'location:clear',
        nodeId: localNode.id,
      });
    }
  }, [localFixedLocation, localNode, localNodePosition, locationDraft, pushNotification, sendGatewayMessage]);

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
      setSocketState('Đã kết nối gateway.py');
      setSocketReady(true);
      pushNotification({
        dedupeKey: 'ws-connected',
        title: 'Gateway đã kết nối',
        detail: 'Kênh WebSocket sẵn sàng.',
        level: 'info',
      });
      socket.send(JSON.stringify({ type: 'sync' }));
      socket.send(JSON.stringify({ type: 'settings:get' }));
      socket.send(JSON.stringify({ type: 'location:get' }));
    };

    socket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);

        if (isGatewayAck(parsed)) {
          const dest = parsed.destination || 'unknown';
          pushNotification({
            dedupeKey: `gateway-ack-${dest}`,
            title: 'Gateway ACK',
            detail: `Đã gửi lệnh đến ${dest}`,
            level: 'info',
          });
          return;
        }

        if (isMeshAck(parsed)) {
          const from = parsed.fromId || 'unknown';
          const reason = parsed.errorReason || 'NONE';
          pushNotification({
            dedupeKey: `mesh-ack-${from}-${reason}`,
            title: `ACK Mesh từ ${from}`,
            detail: `Trạng thái: ${reason}`,
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
              detail: 'Lệnh đã được node tiếp nhận.',
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
            title: text ? `Phản hồi từ ${from}` : `Nhận packet từ ${from}`,
            detail: text ? `${text}${signal}` : signal || 'Packet không có text',
            level: 'info',
          });
          return;
        }

        if (parsed?.type === 'SETTINGS_DATA') {
          setSettingsData({ ...DEFAULT_DASHBOARD_SETTINGS, ...(parsed.settings || {}) });
          return;
        }

        if (parsed?.type === 'SETTINGS_UPDATED') {
          setSettingsData({ ...DEFAULT_DASHBOARD_SETTINGS, ...(parsed.settings || {}) });
          const hardwareApply = parsed.hardwareApply || {};
          const appliedCount = Array.isArray(hardwareApply.appliedFields)
            ? hardwareApply.appliedFields.length
            : 0;
          const errorCount = Array.isArray(hardwareApply.errors)
            ? hardwareApply.errors.length
            : 0;
          const unsupportedCount = Array.isArray(hardwareApply.unsupportedFields)
            ? hardwareApply.unsupportedFields.length
            : 0;

          let detail = 'Thông số dashboard/gateway đã được lưu.';
          if (hardwareApply.connected === false) {
            detail = 'Đã lưu gateway, nhưng chưa ghi xuống thiết bị vì chưa kết nối node local.';
          } else if (appliedCount > 0 && errorCount === 0) {
            detail = `Đã ghi ${appliedCount} thông số xuống thiết bị local.`;
          } else if (appliedCount > 0 && errorCount > 0) {
            detail = `Ghi một phần: ${appliedCount} thông số OK, ${errorCount} lỗi.`;
          } else if (errorCount > 0) {
            detail = `Đã lưu gateway nhưng ghi thiết bị thất bại (${errorCount} lỗi).`;
          }

          if (unsupportedCount > 0 && appliedCount > 0) {
            detail += ` ${unsupportedCount} trường chưa hỗ trợ ghi trực tiếp.`;
          }

          pushNotification({
            dedupeKey: 'settings-updated',
            title: 'Đã cập nhật cài đặt',
            detail,
            level: errorCount > 0 ? 'critical' : 'info',
            shouldToast: errorCount > 0,
            toastType: errorCount > 0 ? 'warn' : 'success',
          });
          return;
        }

        if (parsed?.type === 'FIXED_LOCATIONS_DATA') {
          setFixedLocations(parsed.locations || {});
          return;
        }

        if (parsed?.type === 'FIXED_LOCATION_UPDATED') {
          if (parsed.location?.nodeId) {
            setFixedLocations((current) => ({ ...current, [parsed.location.nodeId]: parsed.location }));
          }
          setIsLocationSetMode(false);
          setLocationDraft(null);
          pushNotification({
            dedupeKey: 'fixed-location-updated',
            title: 'Đã lưu vị trí cố định',
            detail: 'Vị trí local node đã được cập nhật trên gateway.',
            level: 'info',
            shouldToast: true,
            toastType: 'success',
          });
          return;
        }

        if (parsed?.type === 'FIXED_LOCATION_CLEARED') {
          const nodeId = parsed.nodeId;
          if (nodeId) {
            setFixedLocations((current) => {
              const next = { ...current };
              delete next[nodeId];
              return next;
            });
          }
          setIsLocationSetMode(false);
          setLocationDraft(null);
          pushNotification({
            dedupeKey: 'fixed-location-cleared',
            title: 'Đã xóa vị trí cố định',
            detail: 'Local node quay lại chế độ không có fixed location.',
            level: 'info',
          });
          return;
        }

        if (parsed?.type === 'STATUS' && parsed?.status === 'error') {
          pushNotification({
            dedupeKey: `gateway-status-error-${String(parsed.message || 'unknown')}`,
            title: 'Gateway báo lỗi',
            detail: String(parsed.message || 'Không rõ nguyên nhân'),
            level: 'critical',
            shouldToast: true,
            toastType: 'error',
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
              title: 'Pin yếu dưới 15%',
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
            title: joinedNames.length > 1 ? `${joinedNames.length} trạm mới gia nhập` : 'Trạm mới gia nhập',
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
      setSocketReady(false);
      setSocketState('Mất kết nối WebSocket. Đang chờ gateway.py...');
      pushNotification({
        dedupeKey: 'ws-error',
        title: 'Mất kết nối gateway',
        detail: 'Đang thử kết nối lại WebSocket.',
        level: 'critical',
        shouldToast: true,
        toastType: 'warn',
      });
    };

    socket.onclose = () => {
      setSocketReady(false);
      setSocketState('WebSocket đã đóng. Mở lại app để kết nối lại.');
      pushNotification({
        dedupeKey: 'ws-closed',
        title: 'WebSocket đã đóng',
        detail: 'Cần khởi động lại app hoặc gateway.',
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
          {isLocationSetMode && (
            <p className="location-set-hint">Chế độ set location đang bật: click lên map để chọn điểm cho local node.</p>
          )}
        </div>
        <div className="notice-actions">
          <button
            type="button"
            className="notice-toggle"
            onClick={() => setIsSettingsOpen(true)}
          >
            Cài đặt
          </button>
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
            Thông báo
            {unreadCount > 0 && <span className="notice-badge">{unreadCount}</span>}
          </button>
        </div>
      </header>

      <div className="monitor-layout">
        <aside className="node-sidebar">
          <h3>Node Đang Hoạt Động</h3>

          {selectedNode && (
            <div className="selected-node-panel">
              <h4>Thông số node đang chọn</h4>
              <p><strong>Tên:</strong> {selectedNode.name}</p>
              <p><strong>ID:</strong> {selectedNode.id}</p>
              <p><strong>Loại:</strong> {selectedNode.type === 'gateway' ? 'Gateway' : 'Node ngoài'}</p>
              <p><strong>Trạng thái:</strong> {selectedNode.status === 'online' ? 'Online' : 'Offline'}</p>
              <p><strong>Pin:</strong> {Number.isFinite(selectedNode.battery) ? `${selectedNode.battery}%` : 'N/A'}</p>
              <p><strong>Tín hiệu:</strong> {Number.isFinite(selectedNode.rssi) ? `${selectedNode.rssi} dBm` : 'N/A'}</p>
              <p><strong>Last seen:</strong> {selectedNode.lastSeen || formatLastUpdated(selectedNode.lastUpdated)}</p>
            </div>
          )}

          {activeNodes.length === 0 && <p className="empty-side">Chưa có node online.</p>}

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
                  <span>Tín hiệu: {Number.isFinite(node.rssi) ? `${node.rssi} dBm` : 'N/A'}</span>
                  <span>Last seen: {node.lastSeen || formatLastUpdated(node.lastUpdated)}</span>
                </div>
              </button>
            );
          })}

          <h3 className="offline-title">Node Đã Mất Kết Nối</h3>
          {offlineNodes.length === 0 && <p className="empty-side">Không có node offline.</p>}
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
                  <span>Tín hiệu: {Number.isFinite(node.rssi) ? `${node.rssi} dBm` : 'N/A'}</span>
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
            onClick={(event) => {
              if (isLocationSetMode) {
                const clickedLat = Number(event.lngLat?.lat);
                const clickedLng = Number(event.lngLat?.lng);
                if (Number.isFinite(clickedLat) && Number.isFinite(clickedLng)) {
                  setLocationDraft({ lat: clickedLat, lng: clickedLng });
                }
                return;
              }

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
                  <p>Loại trạm: {selectedNode.type === 'gateway' ? 'Trạm điều hành' : 'Trạm còi hú'}</p>
                  <p className="rssi-line">
                    <SignalIcon rssi={selectedNode.rssi} /> RSSI: {Number.isFinite(selectedNode.rssi) ? `${selectedNode.rssi} dBm` : 'N/A'}
                  </p>
                  <p>Pin: {Number.isFinite(selectedNode.battery) ? `${selectedNode.battery}%` : 'Chưa có dữ liệu'}</p>
                  <p>Last seen: {selectedNode.lastSeen || formatLastUpdated(selectedNode.lastUpdated)}</p>
                </div>
              </Popup>
            )}
          </MapView>
        </div>
      </div>

      {nodes.length === 0 && (
        <p className="empty-note">
          Chưa nhận được node nào từ gateway.py. Bản đồ sẽ cập nhật ngay khi có dữ liệu thật.
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
          <div className="notification-head-actions">
            <button type="button" onClick={markAllNotificationsRead}>Đọc tất cả</button>
            <button type="button" onClick={() => setIsNotificationPanelOpen(false)}>Đóng</button>
          </div>
        </div>

        <div className="notification-tabs">
          {[
            { id: 'all', label: 'Tất cả' },
            { id: 'critical', label: 'Cảnh báo' },
            { id: 'info', label: 'Thông tin' },
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
          {filteredNotifications.length === 0 && <p className="notification-empty">Chưa có thông báo.</p>}
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
              {item.count > 1 && <small>Lặp lại {item.count} lần</small>}
            </button>
          ))}
        </div>
      </aside>

      <SettingsDrawer
        open={isSettingsOpen}
        settings={settingsData}
        locationState={{
          socketReady,
          localNodeName: localNode?.name || '',
          localNodeId: localNode?.id || '',
          localNodeStatus: localNode?.status || '',
          localNodePosition,
          localFixedLocation,
          locationDraft,
          isLocationSetMode,
        }}
        onLocationAction={handleLocationAction}
        onClose={() => setIsSettingsOpen(false)}
        onSave={(nextSettings) => {
          sendGatewayMessage({ type: 'settings:set', settings: nextSettings });
        }}
        onReset={() => {
          sendGatewayMessage({ type: 'settings:reset' });
        }}
      />

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
