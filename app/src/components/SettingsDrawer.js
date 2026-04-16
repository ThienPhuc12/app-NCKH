import { useEffect, useMemo, useState } from 'react';
import './SettingsDrawer.css';

const TAB_ORDER = ['radio', 'lora', 'power', 'display', 'bluetooth', 'position', 'location', 'device', 'module', 'connections'];
const MODEM_PRESET_OPTIONS = [
  { value: 'VERY_LONG_SLOW', label: 'Very Long Slow (xa nhất)' },
  { value: 'LONG_SLOW', label: 'Long Slow (xa, ổn định)' },
  { value: 'LONG_FAST', label: 'Long Fast (cân bằng)' },
  { value: 'MEDIUM_SLOW', label: 'Medium Slow' },
  { value: 'MEDIUM_FAST', label: 'Medium Fast' },
  { value: 'SHORT_SLOW', label: 'Short Slow' },
  { value: 'SHORT_FAST', label: 'Short Fast (tốc độ cao)' },
];
const REGION_OPTIONS = ['US', 'EU_868', 'EU_433', 'CN', 'JP', 'ANZ', 'KR', 'TW', 'RU', 'IN', 'TH', 'LORA_24'];
const HOP_LIMIT_OPTIONS = [1, 2, 3, 4, 5, 6, 7];
const DISPLAY_MODE_OPTIONS = ['DEFAULT', 'TWOCOLOR', 'INVERTED', 'COLOR'];
const DISPLAY_UNITS_OPTIONS = ['METRIC', 'IMPERIAL'];
const OLED_OPTIONS = ['OLED_AUTO', 'OLED_SSD1306', 'OLED_SH1106', 'OLED_SH1107', 'OLED_SH1107_128_128'];
const BLUETOOTH_MODE_OPTIONS = ['RANDOM_PIN', 'FIXED_PIN', 'NO_PIN'];
const GPS_MODE_OPTIONS = ['DISABLED', 'ENABLED', 'NOT_PRESENT'];
const DEVICE_ROLE_OPTIONS = ['CLIENT', 'CLIENT_MUTE', 'ROUTER', 'ROUTER_CLIENT', 'REPEATER', 'TRACKER', 'SENSOR', 'TAK', 'CLIENT_HIDDEN', 'LOST_AND_FOUND', 'TAK_TRACKER', 'ROUTER_LATE', 'CLIENT_BASE'];
const REBROADCAST_OPTIONS = ['ALL', 'ALL_SKIP_DECODING', 'LOCAL_ONLY', 'KNOWN_ONLY', 'NONE', 'CORE_PORTNUMS_ONLY'];
const BUZZER_OPTIONS = ['ALL_ENABLED', 'DISABLED', 'NOTIFICATIONS_ONLY', 'SYSTEM_ONLY', 'DIRECT_MSG_ONLY'];

const DEFAULT_SETTINGS = {
  radio: {
    snrGoodDb: -7,
    snrFairDb: -15,
    rssiGoodDbm: -115,
    rssiFairDbm: -126,
    usePreset: true,
    modemPreset: 'LONG_FAST',
    tracePortnum: 70,
    routeDashMs: 700,
    autoReconnect: true,
  },
  lora: {
    region: 'US',
    hopLimit: 7,
    channelNum: 0,
    ignoreMqtt: false,
    configOkToMqtt: false,
    usePreset: true,
    modemPreset: 'LONG_FAST',
    bandwidth: 250,
    spreadFactor: 11,
    codingRate: 7,
    txEnabled: true,
    txPower: 17,
    overrideDutyCycle: false,
    frequencyOffset: 0,
    sx126xRxBoostedGain: false,
    overrideFrequency: 0,
  },
  power: {
    isPowerSaving: false,
    onBatteryShutdownAfterSecs: 0,
    adcMultiplierOverride: 0,
    waitBluetoothSecs: 0,
    deviceBatteryInaAddress: 0,
    sdsSecs: 0,
    lsSecs: 0,
    minWakeSecs: 0,
  },
  display: {
    screenOnSecs: 30,
    gpsFormat: 'UNUSED',
    autoScreenCarouselSecs: 0,
    compassNorthTop: true,
    use12hClock: false,
    flipScreen: false,
    units: 'METRIC',
    oled: 'OLED_AUTO',
    displaymode: 'DEFAULT',
    headingBold: false,
    wakeOnTapOrMotion: false,
  },
  bluetooth: {
    enabled: true,
    mode: 'RANDOM_PIN',
    fixedPin: 0,
  },
  position: {
    positionBroadcastSmartEnabled: true,
    gpsMode: 'ENABLED',
    fixedPosition: false,
    positionBroadcastSecs: 0,
    gpsUpdateInterval: 0,
    gpsAttemptTime: 0,
    broadcastSmartMinimumDistance: 0,
    broadcastSmartMinimumIntervalSecs: 0,
    positionFlags: 0,
    rxGpio: 0,
    txGpio: 0,
    gpsEnGpio: 0,
  },
  device: {
    theme: 'midnight',
    language: 'vi',
    density: 'comfortable',
    role: 'CLIENT',
    serialEnabled: true,
    buttonGpio: 0,
    buzzerGpio: 0,
    rebroadcastMode: 'ALL',
    nodeInfoBroadcastSecs: 0,
    doubleTapAsButtonPress: false,
    isManaged: false,
    disableTripleClick: false,
    tzdef: '',
    ledHeartbeatDisabled: false,
    buzzerMode: 'ALL_ENABLED',
    showOfflineNodes: false,
    rememberSelectedNode: true,
    fitBoundsOnStart: true,
  },
  module: {
    showNotifications: true,
    showTraceOverlayOnStart: false,
    showConnectionCard: true,
    lowBatteryThreshold: 15,
    notificationRetention: 80,
    nodeBlackListSuffixes: 'd4d4',
  },
  connections: {
    gatewayUrl: process.env.REACT_APP_GATEWAY_WS || 'ws://127.0.0.1:8765',
    autoScanIntervalSec: 5,
    reconnectTimeoutSec: 6,
    manualConnectHoldMs: 3000,
  },
};

function cloneSettings(settings) {
  return {
    radio: { ...DEFAULT_SETTINGS.radio, ...(settings?.radio || {}) },
    lora: { ...DEFAULT_SETTINGS.lora, ...(settings?.lora || {}) },
    power: { ...DEFAULT_SETTINGS.power, ...(settings?.power || {}) },
    display: { ...DEFAULT_SETTINGS.display, ...(settings?.display || {}) },
    bluetooth: { ...DEFAULT_SETTINGS.bluetooth, ...(settings?.bluetooth || {}) },
    position: { ...DEFAULT_SETTINGS.position, ...(settings?.position || {}) },
    device: { ...DEFAULT_SETTINGS.device, ...(settings?.device || {}) },
    module: { ...DEFAULT_SETTINGS.module, ...(settings?.module || {}) },
    connections: { ...DEFAULT_SETTINGS.connections, ...(settings?.connections || {}) },
  };
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatLocationPair(value) {
  const lat = Number(value?.lat);
  const lng = Number(value?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return 'Chưa có';
  }
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

function SettingsDrawer({
  open,
  settings,
  locationState,
  onLocationAction,
  onClose,
  onSave,
  onReset,
}) {
  const [activeTab, setActiveTab] = useState('radio');
  const [draft, setDraft] = useState(() => cloneSettings(settings));

  useEffect(() => {
    if (open) {
      setDraft(cloneSettings(settings));
      setActiveTab('radio');
    }
  }, [open, settings]);

  const sectionLabels = useMemo(
    () => ({
      radio: 'Radio',
      lora: 'LoRa',
      power: 'Power',
      display: 'Display',
      bluetooth: 'Bluetooth',
      position: 'Position',
      location: 'Location',
      device: 'Device',
      module: 'Module',
      connections: 'Connections',
    }),
    [],
  );

  function updateSection(section, key, value) {
    setDraft((current) => ({
      ...current,
      [section]: {
        ...current[section],
        [key]: value,
      },
    }));
  }

  function handleSave() {
    onSave(draft);
    onClose();
  }

  function handleReset() {
    const next = cloneSettings(DEFAULT_SETTINGS);
    setDraft(next);
    onReset?.(next);
    setActiveTab('radio');
  }

  if (!open) {
    return null;
  }

  return (
    <div className="settings-overlay" role="presentation" onMouseDown={onClose}>
      <aside className="settings-drawer" role="dialog" aria-modal="true" aria-label="Cài đặt hệ thống" onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <div>
            <p className="settings-kicker">Web-main style settings</p>
            <h2>Cài đặt</h2>
            <span>Đồng bộ cài đặt qua API gateway.</span>
          </div>
          <button type="button" className="settings-close" onClick={onClose} aria-label="Đóng cài đặt">
            
          </button>
        </div>

        <nav className="settings-tabs" aria-label="Nhóm cài đặt">
          {TAB_ORDER.map((tabKey) => (
            <button
              key={tabKey}
              type="button"
              className={`settings-tab ${activeTab === tabKey ? 'active' : ''}`}
              onClick={() => setActiveTab(tabKey)}
            >
              {sectionLabels[tabKey]}
            </button>
          ))}
        </nav>

        <div className="settings-body">
          {activeTab === 'radio' && (
            <section className="settings-section">
              <h3>Radio config</h3>
              <div className="settings-grid">
                <label>
                  Modem preset
                  <select value={draft.radio.modemPreset} onChange={(event) => updateSection('radio', 'modemPreset', event.target.value)}>
                    {MODEM_PRESET_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  SNR tốt hơn
                  <input type="number" value={draft.radio.snrGoodDb} onChange={(event) => updateSection('radio', 'snrGoodDb', toNumber(event.target.value, draft.radio.snrGoodDb))} />
                </label>
                <label>
                  SNR trung bình
                  <input type="number" value={draft.radio.snrFairDb} onChange={(event) => updateSection('radio', 'snrFairDb', toNumber(event.target.value, draft.radio.snrFairDb))} />
                </label>
                <label>
                  RSSI tốt hơn
                  <input type="number" value={draft.radio.rssiGoodDbm} onChange={(event) => updateSection('radio', 'rssiGoodDbm', toNumber(event.target.value, draft.radio.rssiGoodDbm))} />
                </label>
                <label>
                  RSSI trung bình
                  <input type="number" value={draft.radio.rssiFairDbm} onChange={(event) => updateSection('radio', 'rssiFairDbm', toNumber(event.target.value, draft.radio.rssiFairDbm))} />
                </label>
                <label>
                  Port traceroute
                  <input type="number" value={draft.radio.tracePortnum} onChange={(event) => updateSection('radio', 'tracePortnum', toNumber(event.target.value, draft.radio.tracePortnum))} />
                </label>
                <label>
                  Tốc độ nét route (ms)
                  <input type="number" value={draft.radio.routeDashMs} onChange={(event) => updateSection('radio', 'routeDashMs', toNumber(event.target.value, draft.radio.routeDashMs))} />
                </label>
              </div>
              <label className="settings-switch">
                <input type="checkbox" checked={draft.radio.usePreset} onChange={(event) => updateSection('radio', 'usePreset', event.target.checked)} />
                <span>Dùng preset radio</span>
              </label>
              <label className="settings-switch">
                <input type="checkbox" checked={draft.radio.autoReconnect} onChange={(event) => updateSection('radio', 'autoReconnect', event.target.checked)} />
                <span>Tự reconnect gateway</span>
              </label>
            </section>
          )}

          {activeTab === 'lora' && (
            <section className="settings-section">
              <h3>LoRa config</h3>
              <div className="settings-grid">
                <label>
                  Region
                  <select value={draft.lora.region} onChange={(event) => updateSection('lora', 'region', event.target.value)}>
                    {REGION_OPTIONS.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Hop limit
                  <select value={draft.lora.hopLimit} onChange={(event) => updateSection('lora', 'hopLimit', toNumber(event.target.value, draft.lora.hopLimit))}>
                    {HOP_LIMIT_OPTIONS.map((option) => (<option key={option} value={option}>{option}</option>))}
                  </select>
                </label>
                <label>
                  Channel num
                  <input type="number" value={draft.lora.channelNum} onChange={(event) => updateSection('lora', 'channelNum', toNumber(event.target.value, draft.lora.channelNum))} />
                </label>
                <label>
                  Modem preset
                  <select value={draft.lora.modemPreset} onChange={(event) => updateSection('lora', 'modemPreset', event.target.value)}>
                    {MODEM_PRESET_OPTIONS.map((option) => (<option key={option.value} value={option.value}>{option.label}</option>))}
                  </select>
                </label>
                <label>
                  Bandwidth (kHz)
                  <input type="number" value={draft.lora.bandwidth} onChange={(event) => updateSection('lora', 'bandwidth', toNumber(event.target.value, draft.lora.bandwidth))} />
                </label>
                <label>
                  Spread factor
                  <input type="number" value={draft.lora.spreadFactor} onChange={(event) => updateSection('lora', 'spreadFactor', toNumber(event.target.value, draft.lora.spreadFactor))} />
                </label>
                <label>
                  Coding rate
                  <input type="number" value={draft.lora.codingRate} onChange={(event) => updateSection('lora', 'codingRate', toNumber(event.target.value, draft.lora.codingRate))} />
                </label>
                <label>
                  Tx power (dBm)
                  <input type="number" value={draft.lora.txPower} onChange={(event) => updateSection('lora', 'txPower', toNumber(event.target.value, draft.lora.txPower))} />
                </label>
                <label>
                  Frequency offset (Hz)
                  <input type="number" value={draft.lora.frequencyOffset} onChange={(event) => updateSection('lora', 'frequencyOffset', toNumber(event.target.value, draft.lora.frequencyOffset))} />
                </label>
                <label>
                  Override frequency (MHz)
                  <input type="number" step="0.001" value={draft.lora.overrideFrequency} onChange={(event) => updateSection('lora', 'overrideFrequency', toNumber(event.target.value, draft.lora.overrideFrequency))} />
                </label>
              </div>
              <label className="settings-switch"><input type="checkbox" checked={draft.lora.usePreset} onChange={(event) => updateSection('lora', 'usePreset', event.target.checked)} /><span>Use preset</span></label>
              <label className="settings-switch"><input type="checkbox" checked={draft.lora.txEnabled} onChange={(event) => updateSection('lora', 'txEnabled', event.target.checked)} /><span>Tx enabled</span></label>
              <label className="settings-switch"><input type="checkbox" checked={draft.lora.ignoreMqtt} onChange={(event) => updateSection('lora', 'ignoreMqtt', event.target.checked)} /><span>Ignore MQTT</span></label>
              <label className="settings-switch"><input type="checkbox" checked={draft.lora.configOkToMqtt} onChange={(event) => updateSection('lora', 'configOkToMqtt', event.target.checked)} /><span>Config OK to MQTT</span></label>
              <label className="settings-switch"><input type="checkbox" checked={draft.lora.overrideDutyCycle} onChange={(event) => updateSection('lora', 'overrideDutyCycle', event.target.checked)} /><span>Override duty cycle</span></label>
              <label className="settings-switch"><input type="checkbox" checked={draft.lora.sx126xRxBoostedGain} onChange={(event) => updateSection('lora', 'sx126xRxBoostedGain', event.target.checked)} /><span>SX126x boosted RX gain</span></label>
            </section>
          )}

          {activeTab === 'power' && (
            <section className="settings-section">
              <h3>Power config</h3>
              <div className="settings-grid">
                <label><input type="checkbox" checked={draft.power.isPowerSaving} onChange={(event) => updateSection('power', 'isPowerSaving', event.target.checked)} /> Power saving</label>
                <label>Shutdown after secs<input type="number" value={draft.power.onBatteryShutdownAfterSecs} onChange={(event) => updateSection('power', 'onBatteryShutdownAfterSecs', toNumber(event.target.value, draft.power.onBatteryShutdownAfterSecs))} /></label>
                <label>ADC multiplier<input type="number" step="0.0001" value={draft.power.adcMultiplierOverride} onChange={(event) => updateSection('power', 'adcMultiplierOverride', toNumber(event.target.value, draft.power.adcMultiplierOverride))} /></label>
                <label>Wait BT secs<input type="number" value={draft.power.waitBluetoothSecs} onChange={(event) => updateSection('power', 'waitBluetoothSecs', toNumber(event.target.value, draft.power.waitBluetoothSecs))} /></label>
                <label>Battery INA addr<input type="number" value={draft.power.deviceBatteryInaAddress} onChange={(event) => updateSection('power', 'deviceBatteryInaAddress', toNumber(event.target.value, draft.power.deviceBatteryInaAddress))} /></label>
                <label>SDS secs<input type="number" value={draft.power.sdsSecs} onChange={(event) => updateSection('power', 'sdsSecs', toNumber(event.target.value, draft.power.sdsSecs))} /></label>
                <label>LS secs<input type="number" value={draft.power.lsSecs} onChange={(event) => updateSection('power', 'lsSecs', toNumber(event.target.value, draft.power.lsSecs))} /></label>
                <label>Min wake secs<input type="number" value={draft.power.minWakeSecs} onChange={(event) => updateSection('power', 'minWakeSecs', toNumber(event.target.value, draft.power.minWakeSecs))} /></label>
              </div>
            </section>
          )}

          {activeTab === 'display' && (
            <section className="settings-section">
              <h3>Display config</h3>
              <div className="settings-grid">
                <label>Screen on secs<input type="number" value={draft.display.screenOnSecs} onChange={(event) => updateSection('display', 'screenOnSecs', toNumber(event.target.value, draft.display.screenOnSecs))} /></label>
                <label>GPS format<select value={draft.display.gpsFormat} onChange={(event) => updateSection('display', 'gpsFormat', event.target.value)}><option value="UNUSED">UNUSED</option></select></label>
                <label>Carousel secs<input type="number" value={draft.display.autoScreenCarouselSecs} onChange={(event) => updateSection('display', 'autoScreenCarouselSecs', toNumber(event.target.value, draft.display.autoScreenCarouselSecs))} /></label>
                <label>Units<select value={draft.display.units} onChange={(event) => updateSection('display', 'units', event.target.value)}>{DISPLAY_UNITS_OPTIONS.map((option) => (<option key={option} value={option}>{option}</option>))}</select></label>
                <label>OLED<select value={draft.display.oled} onChange={(event) => updateSection('display', 'oled', event.target.value)}>{OLED_OPTIONS.map((option) => (<option key={option} value={option}>{option}</option>))}</select></label>
                <label>Display mode<select value={draft.display.displaymode} onChange={(event) => updateSection('display', 'displaymode', event.target.value)}>{DISPLAY_MODE_OPTIONS.map((option) => (<option key={option} value={option}>{option}</option>))}</select></label>
              </div>
              <label className="settings-switch"><input type="checkbox" checked={draft.display.compassNorthTop} onChange={(event) => updateSection('display', 'compassNorthTop', event.target.checked)} /><span>Compass north top</span></label>
              <label className="settings-switch"><input type="checkbox" checked={draft.display.use12hClock} onChange={(event) => updateSection('display', 'use12hClock', event.target.checked)} /><span>Use 12h clock</span></label>
              <label className="settings-switch"><input type="checkbox" checked={draft.display.flipScreen} onChange={(event) => updateSection('display', 'flipScreen', event.target.checked)} /><span>Flip screen</span></label>
              <label className="settings-switch"><input type="checkbox" checked={draft.display.headingBold} onChange={(event) => updateSection('display', 'headingBold', event.target.checked)} /><span>Heading bold</span></label>
              <label className="settings-switch"><input type="checkbox" checked={draft.display.wakeOnTapOrMotion} onChange={(event) => updateSection('display', 'wakeOnTapOrMotion', event.target.checked)} /><span>Wake on tap or motion</span></label>
            </section>
          )}

          {activeTab === 'bluetooth' && (
            <section className="settings-section">
              <h3>Bluetooth config</h3>
              <div className="settings-grid">
                <label><input type="checkbox" checked={draft.bluetooth.enabled} onChange={(event) => updateSection('bluetooth', 'enabled', event.target.checked)} /> Enabled</label>
                <label>Pairing mode<select value={draft.bluetooth.mode} onChange={(event) => updateSection('bluetooth', 'mode', event.target.value)}>{BLUETOOTH_MODE_OPTIONS.map((option) => (<option key={option} value={option}>{option}</option>))}</select></label>
                <label>Fixed pin<input type="number" value={draft.bluetooth.fixedPin} onChange={(event) => updateSection('bluetooth', 'fixedPin', toNumber(event.target.value, draft.bluetooth.fixedPin))} /></label>
              </div>
            </section>
          )}

          {activeTab === 'position' && (
            <section className="settings-section">
              <h3>Position config</h3>
              <div className="settings-grid">
                <label><input type="checkbox" checked={draft.position.positionBroadcastSmartEnabled} onChange={(event) => updateSection('position', 'positionBroadcastSmartEnabled', event.target.checked)} /> Smart broadcast</label>
                <label>GPS mode<select value={draft.position.gpsMode} onChange={(event) => updateSection('position', 'gpsMode', event.target.value)}>{GPS_MODE_OPTIONS.map((option) => (<option key={option} value={option}>{option}</option>))}</select></label>
                <label><input type="checkbox" checked={draft.position.fixedPosition} onChange={(event) => updateSection('position', 'fixedPosition', event.target.checked)} /> Fixed position</label>
                <label>Broadcast secs<input type="number" value={draft.position.positionBroadcastSecs} onChange={(event) => updateSection('position', 'positionBroadcastSecs', toNumber(event.target.value, draft.position.positionBroadcastSecs))} /></label>
                <label>GPS update interval<input type="number" value={draft.position.gpsUpdateInterval} onChange={(event) => updateSection('position', 'gpsUpdateInterval', toNumber(event.target.value, draft.position.gpsUpdateInterval))} /></label>
                <label>GPS attempt time<input type="number" value={draft.position.gpsAttemptTime} onChange={(event) => updateSection('position', 'gpsAttemptTime', toNumber(event.target.value, draft.position.gpsAttemptTime))} /></label>
                <label>Smart min distance<input type="number" value={draft.position.broadcastSmartMinimumDistance} onChange={(event) => updateSection('position', 'broadcastSmartMinimumDistance', toNumber(event.target.value, draft.position.broadcastSmartMinimumDistance))} /></label>
                <label>Smart min interval (s)<input type="number" value={draft.position.broadcastSmartMinimumIntervalSecs} onChange={(event) => updateSection('position', 'broadcastSmartMinimumIntervalSecs', toNumber(event.target.value, draft.position.broadcastSmartMinimumIntervalSecs))} /></label>
                <label>RX GPIO<input type="number" value={draft.position.rxGpio} onChange={(event) => updateSection('position', 'rxGpio', toNumber(event.target.value, draft.position.rxGpio))} /></label>
                <label>TX GPIO<input type="number" value={draft.position.txGpio} onChange={(event) => updateSection('position', 'txGpio', toNumber(event.target.value, draft.position.txGpio))} /></label>
                <label>GPS EN GPIO<input type="number" value={draft.position.gpsEnGpio} onChange={(event) => updateSection('position', 'gpsEnGpio', toNumber(event.target.value, draft.position.gpsEnGpio))} /></label>
              </div>
            </section>
          )}

          {activeTab === 'location' && (
            <section className="settings-section">
              <h3>Location</h3>
              {!locationState && (
                <p className="settings-note">
                  Mở màn hình Monitoring System để quản lý vị trí cố định cho node local.
                </p>
              )}
              {locationState && (
                <>
                  <div className="settings-grid">
                    <label>
                      Socket gateway
                      <input type="text" readOnly value={locationState.socketReady ? 'Sẵn sàng' : 'Chưa sẵn sàng'} />
                    </label>
                    <label>
                      Node local
                      <input type="text" readOnly value={locationState.localNodeName || locationState.localNodeId || 'Chưa có'} />
                    </label>
                    <label>
                      Trạng thái node
                      <input type="text" readOnly value={locationState.localNodeStatus || 'Chưa rõ'} />
                    </label>
                  </div>

                  <div className="settings-location-card">
                    <p><strong>Node local:</strong> {locationState.localNodeName || locationState.localNodeId || 'Chưa có'}</p>
                    <p><strong>Vị trí cố định hiện tại:</strong> {formatLocationPair(locationState.localFixedLocation)}</p>
                    <p><strong>Vị trí node local:</strong> {formatLocationPair(locationState.localNodePosition)}</p>
                    <p><strong>Điểm đang set:</strong> {formatLocationPair(locationState.locationDraft)}</p>
                  </div>

                  <div className="settings-location-actions">
                    {!locationState.isLocationSetMode && (
                      <button
                        type="button"
                        className="settings-primary"
                        onClick={() => {
                          onLocationAction?.('beginSet');
                          onClose();
                        }}
                        disabled={!locationState.localNodeId}
                      >
                        Bật chọn điểm trên map
                      </button>
                    )}
                    {locationState.isLocationSetMode && (
                      <>
                        <button type="button" className="settings-primary" onClick={() => onLocationAction?.('save')}>
                          Lưu vị trí
                        </button>
                        <button type="button" className="settings-secondary" onClick={() => onLocationAction?.('cancelSet')}>
                          Hủy set
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="settings-secondary"
                      onClick={() => onLocationAction?.('clear')}
                      disabled={!locationState.localFixedLocation}
                    >
                      Xóa vị trí cố định
                    </button>
                  </div>

                  <p className="settings-note">
                    Cách dùng: bấm Bật chọn điểm trên map, click lên map để chọn điểm cho node local,
                    mở lại Cài đặt {'>'} Location và bấm Lưu vị trí.
                  </p>
                </>
              )}
            </section>
          )}

          {activeTab === 'device' && (
            <section className="settings-section">
              <h3>Device config</h3>
              <div className="settings-grid">
                <label>
                  Theme
                  <select value={draft.device.theme} onChange={(event) => updateSection('device', 'theme', event.target.value)}>
                    <option value="midnight">Midnight</option>
                    <option value="aurora">Aurora</option>
                    <option value="graphite">Graphite</option>
                  </select>
                </label>
                <label>
                  Ngôn ngữ
                  <select value={draft.device.language} onChange={(event) => updateSection('device', 'language', event.target.value)}>
                    <option value="vi">Tiếng Việt</option>
                    <option value="en">English</option>
                  </select>
                </label>
                <label>
                  Mật độ giao diện
                  <select value={draft.device.density} onChange={(event) => updateSection('device', 'density', event.target.value)}>
                    <option value="comfortable">Thoáng</option>
                    <option value="compact">Gọn</option>
                  </select>
                </label>
                <label>
                  Role
                  <select value={draft.device.role} onChange={(event) => updateSection('device', 'role', event.target.value)}>
                    {DEVICE_ROLE_OPTIONS.map((option) => (<option key={option} value={option}>{option}</option>))}
                  </select>
                </label>
                <label>
                  Button GPIO
                  <input type="number" value={draft.device.buttonGpio} onChange={(event) => updateSection('device', 'buttonGpio', toNumber(event.target.value, draft.device.buttonGpio))} />
                </label>
                <label>
                  Buzzer GPIO
                  <input type="number" value={draft.device.buzzerGpio} onChange={(event) => updateSection('device', 'buzzerGpio', toNumber(event.target.value, draft.device.buzzerGpio))} />
                </label>
                <label>
                  Rebroadcast mode
                  <select value={draft.device.rebroadcastMode} onChange={(event) => updateSection('device', 'rebroadcastMode', event.target.value)}>
                    {REBROADCAST_OPTIONS.map((option) => (<option key={option} value={option}>{option}</option>))}
                  </select>
                </label>
                <label>
                  Node info broadcast (s)
                  <input type="number" value={draft.device.nodeInfoBroadcastSecs} onChange={(event) => updateSection('device', 'nodeInfoBroadcastSecs', toNumber(event.target.value, draft.device.nodeInfoBroadcastSecs))} />
                </label>
                <label>
                  POSIX timezone (tzdef)
                  <input type="text" value={draft.device.tzdef} onChange={(event) => updateSection('device', 'tzdef', event.target.value)} placeholder="CST6CDT,M3.2.0,M11.1.0" />
                </label>
              </div>
              <label className="settings-switch"><input type="checkbox" checked={draft.device.showOfflineNodes} onChange={(event) => updateSection('device', 'showOfflineNodes', event.target.checked)} /><span>Hiển thị node offline</span></label>
              <label className="settings-switch"><input type="checkbox" checked={draft.device.rememberSelectedNode} onChange={(event) => updateSection('device', 'rememberSelectedNode', event.target.checked)} /><span>Nhớ node đang chọn</span></label>
              <label className="settings-switch"><input type="checkbox" checked={draft.device.fitBoundsOnStart} onChange={(event) => updateSection('device', 'fitBoundsOnStart', event.target.checked)} /><span>Tự fit bản đồ khi mở</span></label>
              <label className="settings-switch"><input type="checkbox" checked={draft.device.serialEnabled} onChange={(event) => updateSection('device', 'serialEnabled', event.target.checked)} /><span>Serial enabled</span></label>
              <label className="settings-switch"><input type="checkbox" checked={draft.device.doubleTapAsButtonPress} onChange={(event) => updateSection('device', 'doubleTapAsButtonPress', event.target.checked)} /><span>Double tap as button press</span></label>
              <label className="settings-switch"><input type="checkbox" checked={draft.device.isManaged} onChange={(event) => updateSection('device', 'isManaged', event.target.checked)} /><span>Managed device</span></label>
              <label className="settings-switch"><input type="checkbox" checked={draft.device.disableTripleClick} onChange={(event) => updateSection('device', 'disableTripleClick', event.target.checked)} /><span>Disable triple click</span></label>
              <label className="settings-switch"><input type="checkbox" checked={draft.device.ledHeartbeatDisabled} onChange={(event) => updateSection('device', 'ledHeartbeatDisabled', event.target.checked)} /><span>Disable LED heartbeat</span></label>
              <label>
                Buzzer mode
                <select value={draft.device.buzzerMode} onChange={(event) => updateSection('device', 'buzzerMode', event.target.value)}>
                  {BUZZER_OPTIONS.map((option) => (<option key={option} value={option}>{option}</option>))}
                </select>
              </label>
            </section>
          )}

          {activeTab === 'module' && (
            <section className="settings-section">
              <h3>Module config</h3>
              <div className="settings-grid">
                <label>
                  Ngưỡng pin yếu (%)
                  <input type="number" value={draft.module.lowBatteryThreshold} onChange={(event) => updateSection('module', 'lowBatteryThreshold', toNumber(event.target.value, draft.module.lowBatteryThreshold))} />
                </label>
                <label>
                  Số lượng thông báo
                  <input type="number" value={draft.module.notificationRetention} onChange={(event) => updateSection('module', 'notificationRetention', toNumber(event.target.value, draft.module.notificationRetention))} />
                </label>
                <label>
                  Node suffix blacklist
                  <input type="text" value={draft.module.nodeBlackListSuffixes} onChange={(event) => updateSection('module', 'nodeBlackListSuffixes', event.target.value)} placeholder="d4d4,abcd" />
                </label>
              </div>
              <label className="settings-switch"><input type="checkbox" checked={draft.module.showNotifications} onChange={(event) => updateSection('module', 'showNotifications', event.target.checked)} /><span>Bật toast / notification</span></label>
              <label className="settings-switch"><input type="checkbox" checked={draft.module.showTraceOverlayOnStart} onChange={(event) => updateSection('module', 'showTraceOverlayOnStart', event.target.checked)} /><span>Mở traceroute overlay mặc định</span></label>
              <label className="settings-switch"><input type="checkbox" checked={draft.module.showConnectionCard} onChange={(event) => updateSection('module', 'showConnectionCard', event.target.checked)} /><span>Hiển thị thẻ trạng thái kết nối</span></label>
            </section>
          )}

          {activeTab === 'connections' && (
            <section className="settings-section">
              <h3>Connections</h3>
              <div className="settings-grid">
                <label>
                  Gateway WebSocket
                  <input type="text" value={draft.connections.gatewayUrl} onChange={(event) => updateSection('connections', 'gatewayUrl', event.target.value.trim())} placeholder="ws://127.0.0.1:8765" />
                </label>
                <label>
                  Tần suất auto-scan (giây)
                  <input type="number" value={draft.connections.autoScanIntervalSec} onChange={(event) => updateSection('connections', 'autoScanIntervalSec', toNumber(event.target.value, draft.connections.autoScanIntervalSec))} />
                </label>
                <label>
                  Timeout reconnect (giây)
                  <input type="number" value={draft.connections.reconnectTimeoutSec} onChange={(event) => updateSection('connections', 'reconnectTimeoutSec', toNumber(event.target.value, draft.connections.reconnectTimeoutSec))} />
                </label>
                <label>
                  Giữ nút connect (ms)
                  <input type="number" value={draft.connections.manualConnectHoldMs} onChange={(event) => updateSection('connections', 'manualConnectHoldMs', toNumber(event.target.value, draft.connections.manualConnectHoldMs))} />
                </label>
              </div>
              <p className="settings-note">Các giá trị này được lưu bằng backend API và áp dụng runtime khi có thể.</p>
            </section>
          )}
        </div>

        <div className="settings-footer">
          <button type="button" className="settings-secondary" onClick={handleReset}>
            Reset mặc định
          </button>
          <div className="settings-footer-actions">
            <button type="button" className="settings-secondary" onClick={onClose}>
              Hủy
            </button>
            <button type="button" className="settings-primary" onClick={handleSave}>
              Lưu cài đặt
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

export default SettingsDrawer;
