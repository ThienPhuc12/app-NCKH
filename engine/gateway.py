import asyncio
import copy
import json
import logging
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from pubsub import pub
from serial.tools import list_ports
import websockets
from websockets.server import WebSocketServerProtocol

from meshtastic import BROADCAST_ADDR, LOCAL_ADDR
from meshtastic.serial_interface import SerialInterface


HOST = "127.0.0.1"
PORT = 8765
ONLINE_WINDOW_SECONDS = int(os.getenv("MESH_NODE_ONLINE_WINDOW", os.getenv("MESH_NODE_OFFLINE_TIMEOUT", "7200")))
ACK_TIMEOUT_SECONDS = int(os.getenv("MESH_ACK_TIMEOUT", "18"))
FANOUT_RETRY_COUNT = int(os.getenv("MESH_FANOUT_RETRIES", "1"))
FANOUT_SEND_GAP_SECONDS = float(os.getenv("MESH_FANOUT_SEND_GAP_SECONDS", "0.2"))
PENDING_TIMEOUT_RETRIES = int(os.getenv("MESH_PENDING_TIMEOUT_RETRIES", "1"))
PENDING_RETRY_GAP_SECONDS = float(os.getenv("MESH_PENDING_RETRY_GAP_SECONDS", "0.35"))
EXCLUDED_NODE_IDS = {
    "!849ad4d4",
}
EXCLUDED_NODE_SUFFIXES = {
    "d4d4",
}

SETTINGS_STORAGE_FILE = "dashboard-settings.json"
NODE_LOCATION_STORAGE_FILE = "dashboard-node-locations.json"
DEFAULT_SETTINGS: dict[str, Any] = {
    "radio": {
        "snrGoodDb": -7,
        "snrFairDb": -15,
        "rssiGoodDbm": -115,
        "rssiFairDbm": -126,
        "usePreset": True,
        "modemPreset": "LONG_FAST",
        "tracePortnum": 70,
        "routeDashMs": 700,
        "autoReconnect": True,
    },
    "lora": {
        "region": "US",
        "hopLimit": 7,
        "channelNum": 0,
        "ignoreMqtt": False,
        "configOkToMqtt": False,
        "usePreset": True,
        "modemPreset": "LONG_FAST",
        "bandwidth": 250,
        "spreadFactor": 11,
        "codingRate": 7,
        "txEnabled": True,
        "txPower": 17,
        "overrideDutyCycle": False,
        "frequencyOffset": 0,
        "sx126xRxBoostedGain": False,
        "overrideFrequency": 0,
    },
    "power": {
        "isPowerSaving": False,
        "onBatteryShutdownAfterSecs": 0,
        "adcMultiplierOverride": 0,
        "waitBluetoothSecs": 0,
        "deviceBatteryInaAddress": 0,
        "sdsSecs": 0,
        "lsSecs": 0,
        "minWakeSecs": 0,
    },
    "display": {
        "screenOnSecs": 30,
        "gpsFormat": "UNUSED",
        "autoScreenCarouselSecs": 0,
        "compassNorthTop": True,
        "use12hClock": False,
        "flipScreen": False,
        "units": "METRIC",
        "oled": "OLED_AUTO",
        "displaymode": "DEFAULT",
        "headingBold": False,
        "wakeOnTapOrMotion": False,
    },
    "bluetooth": {
        "enabled": True,
        "mode": "RANDOM_PIN",
        "fixedPin": 0,
    },
    "position": {
        "positionBroadcastSmartEnabled": True,
        "gpsMode": "ENABLED",
        "fixedPosition": False,
        "positionBroadcastSecs": 0,
        "gpsUpdateInterval": 0,
        "gpsAttemptTime": 0,
        "broadcastSmartMinimumDistance": 0,
        "broadcastSmartMinimumIntervalSecs": 0,
        "positionFlags": 0,
        "rxGpio": 0,
        "txGpio": 0,
        "gpsEnGpio": 0,
    },
    "device": {
        "theme": "midnight",
        "language": "vi",
        "density": "comfortable",
        "role": "CLIENT",
        "serialEnabled": True,
        "buttonGpio": 0,
        "buzzerGpio": 0,
        "rebroadcastMode": "ALL",
        "nodeInfoBroadcastSecs": 0,
        "doubleTapAsButtonPress": False,
        "isManaged": False,
        "disableTripleClick": False,
        "tzdef": "",
        "ledHeartbeatDisabled": False,
        "buzzerMode": "ALL_ENABLED",
        "showOfflineNodes": False,
        "rememberSelectedNode": True,
        "fitBoundsOnStart": True,
    },
    "module": {
        "showNotifications": True,
        "showTraceOverlayOnStart": False,
        "showConnectionCard": True,
        "lowBatteryThreshold": 15,
        "notificationRetention": 80,
        "nodeBlackListSuffixes": "d4d4",
    },
    "connections": {
        "gatewayUrl": f"ws://{HOST}:{PORT}",
        "autoScanIntervalSec": 5,
        "reconnectTimeoutSec": 6,
        "manualConnectHoldMs": 3000,
    },
}

# UI fields that can be mapped to real Meshtastic local config writes.
# Values: (protobuf field name, expected value type)
HARDWARE_APPLY_FIELD_MAP: dict[str, dict[str, tuple[str, str]]] = {
    "lora": {
        "region": ("region", "enum"),
        "hopLimit": ("hop_limit", "int"),
        "ignoreMqtt": ("ignore_mqtt", "bool"),
        "configOkToMqtt": ("config_ok_to_mqtt", "bool"),
        "modemPreset": ("modem_preset", "enum"),
        "bandwidth": ("bandwidth", "int"),
        "spreadFactor": ("spread_factor", "int"),
        "codingRate": ("coding_rate", "int"),
        "txEnabled": ("tx_enabled", "bool"),
        "txPower": ("tx_power", "int"),
        "overrideDutyCycle": ("override_duty_cycle", "bool"),
        "sx126xRxBoostedGain": ("sx126x_rx_boosted_gain", "bool"),
    },
    "power": {
        "isPowerSaving": ("is_power_saving", "bool"),
        "onBatteryShutdownAfterSecs": ("on_battery_shutdown_after_secs", "int"),
        "adcMultiplierOverride": ("adc_multiplier_override", "float"),
        "waitBluetoothSecs": ("wait_bluetooth_secs", "int"),
        "deviceBatteryInaAddress": ("device_battery_ina_address", "int"),
        "sdsSecs": ("sds_secs", "int"),
        "lsSecs": ("ls_secs", "int"),
        "minWakeSecs": ("min_wake_secs", "int"),
    },
    "display": {
        "screenOnSecs": ("screen_on_secs", "int"),
        "gpsFormat": ("gps_format", "enum"),
        "autoScreenCarouselSecs": ("auto_screen_carousel_secs", "int"),
        "compassNorthTop": ("compass_north_top", "bool"),
        "use12hClock": ("use_12h_clock", "bool"),
        "flipScreen": ("flip_screen", "bool"),
        "units": ("units", "enum"),
        "oled": ("oled", "enum"),
        "displaymode": ("displaymode", "enum"),
        "headingBold": ("heading_bold", "bool"),
        "wakeOnTapOrMotion": ("wake_on_tap_or_motion", "bool"),
    },
    "bluetooth": {
        "enabled": ("enabled", "bool"),
        "mode": ("mode", "enum"),
        "fixedPin": ("fixed_pin", "int"),
    },
    "position": {
        "positionBroadcastSmartEnabled": ("position_broadcast_smart_enabled", "bool"),
        "gpsMode": ("gps_mode", "enum"),
        "positionBroadcastSecs": ("position_broadcast_secs", "int"),
        "gpsUpdateInterval": ("gps_update_interval", "int"),
        "gpsAttemptTime": ("gps_attempt_time", "int"),
        "broadcastSmartMinimumDistance": ("broadcast_smart_minimum_distance", "int"),
        "broadcastSmartMinimumIntervalSecs": ("broadcast_smart_minimum_interval_secs", "int"),
        "positionFlags": ("position_flags", "int"),
        "rxGpio": ("rx_gpio", "int"),
        "txGpio": ("tx_gpio", "int"),
        "gpsEnGpio": ("gps_en_gpio", "int"),
    },
    "device": {
        "role": ("role", "enum"),
        "serialEnabled": ("serial_enabled", "bool"),
        "buttonGpio": ("button_gpio", "int"),
        "buzzerGpio": ("buzzer_gpio", "int"),
        "rebroadcastMode": ("rebroadcast_mode", "enum"),
        "nodeInfoBroadcastSecs": ("node_info_broadcast_secs", "int"),
        "doubleTapAsButtonPress": ("double_tap_as_button_press", "bool"),
        "isManaged": ("is_managed", "bool"),
        "disableTripleClick": ("disable_triple_click", "bool"),
        "tzdef": ("tzdef", "str"),
        "ledHeartbeatDisabled": ("led_heartbeat_disabled", "bool"),
        "buzzerMode": ("buzzer_mode", "enum"),
    },
}


logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(message)s",
)


@dataclass
class GatewayConnection:
    iface: Optional[SerialInterface] = None
    port_name: Optional[str] = None


class MeshtasticGateway:
    def __init__(self) -> None:
        self.clients: set[WebSocketServerProtocol] = set()
        self.conn = GatewayConnection()
        self.lock = asyncio.Lock()
        self.nodes: dict[str, dict[str, Any]] = {}
        self.last_connect_error: Optional[str] = None
        self.known_hwids: dict[tuple[int, int], dict[str, str]] = {}
        self.known_tokens: set[str] = {
            "heltec",
            "meshtastic",
            "cp210",
            "ch340",
            "usb serial",
            "uart",
            "cdc",
        }
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self._subscribed = False
        self.pending_commands: dict[int, dict[str, Any]] = {}
        self.node_activity: dict[str, float] = {}
        self.settings = copy.deepcopy(DEFAULT_SETTINGS)
        self.settings_file = self._resolve_storage_file(SETTINGS_STORAGE_FILE)
        self.node_locations_file = self._resolve_storage_file(NODE_LOCATION_STORAGE_FILE)
        self.node_locations: dict[str, dict[str, Any]] = {}

        self._cb_node_updated = self._on_node_updated
        self._cb_connection_established = self._on_connection_established
        self._cb_connection_lost = self._on_connection_lost
        self._cb_receive = self._on_receive_packet

        self._load_firmware_board_signatures()
        self._load_settings_from_disk()
        self._load_node_locations_from_disk()

    @staticmethod
    def _timestamp_from_iso(value: Any) -> Optional[float]:
        if not value:
            return None
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
            except ValueError:
                return None
        return None

    @staticmethod
    def _candidate_firmware_roots() -> list[Path]:
        roots: list[Path] = []

        # Source tree when running from python script.
        roots.append(Path(__file__).resolve().parent.parent)

        # PyInstaller onefile extraction directory.
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            roots.append(Path(str(meipass)).resolve())

        # Directory of the executable for packaged runs.
        if getattr(sys, "frozen", False):
            roots.append(Path(sys.executable).resolve().parent)

        unique_roots: list[Path] = []
        seen: set[str] = set()
        for root in roots:
            key = str(root)
            if key in seen:
                continue
            seen.add(key)
            unique_roots.append(root)
        return unique_roots

    def _load_firmware_board_signatures(self) -> None:
        boards_dir = None
        tried_paths: list[Path] = []
        for root in self._candidate_firmware_roots():
            candidate = root / "firmware-develop" / "boards"
            tried_paths.append(candidate)
            if candidate.exists():
                boards_dir = candidate
                break

        if boards_dir is None:
            logging.info(
                "Firmware board directory not found. Tried: %s",
                ", ".join(str(path) for path in tried_paths),
            )
            return

        loaded_count = 0
        for board_file in boards_dir.glob("*.json"):
            try:
                content = json.loads(board_file.read_text(encoding="utf-8"))
            except Exception:
                continue

            name = str(content.get("name") or board_file.stem)
            vendor = str(content.get("vendor") or "")
            usb_product = str((content.get("build") or {}).get("usb_product") or "")
            variant = str((content.get("build") or {}).get("variant") or "")

            for token in [name, vendor, usb_product, variant]:
                token = token.strip().lower()
                if token:
                    self.known_tokens.add(token)

            hwids = (content.get("build") or {}).get("hwids") or []
            for pair in hwids:
                if not isinstance(pair, list) or len(pair) != 2:
                    continue

                vid_raw, pid_raw = pair
                try:
                    vid = int(str(vid_raw), 16)
                    pid = int(str(pid_raw), 16)
                except ValueError:
                    continue

                self.known_hwids[(vid, pid)] = {
                    "name": name,
                    "vendor": vendor,
                    "usb_product": usb_product,
                    "variant": variant,
                }
                loaded_count += 1

        logging.info(
            "Loaded %s board HWID signatures and %s token hints from firmware",
            loaded_count,
            len(self.known_tokens),
        )

    @staticmethod
    def _resolve_storage_file(file_name: str) -> Path:
        app_data = os.getenv("APPDATA")
        if app_data:
            target_dir = Path(app_data) / "WebDashboardNCKH"
        else:
            target_dir = Path.home() / ".web-dashboard-nckh"
        target_dir.mkdir(parents=True, exist_ok=True)
        return target_dir / file_name

    @staticmethod
    def _copy_settings(settings: dict[str, Any]) -> dict[str, Any]:
        return copy.deepcopy(settings)

    @staticmethod
    def _merge_settings(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
        merged = copy.deepcopy(base)
        for section, values in (patch or {}).items():
            if section not in merged or not isinstance(values, dict):
                continue
            merged[section].update(values)
        return merged

    def _sanitize_settings(self, candidate: dict[str, Any]) -> dict[str, Any]:
        return self._merge_settings(DEFAULT_SETTINGS, candidate)

    def _load_settings_from_disk(self) -> None:
        try:
            if self.settings_file.exists():
                loaded = json.loads(self.settings_file.read_text(encoding="utf-8"))
                self.settings = self._sanitize_settings(loaded if isinstance(loaded, dict) else {})
            else:
                self.settings = self._copy_settings(DEFAULT_SETTINGS)
                self._save_settings_to_disk()
        except Exception as exc:
            logging.warning("Failed to load settings from %s: %s", self.settings_file, exc)
            self.settings = self._copy_settings(DEFAULT_SETTINGS)

    def _save_settings_to_disk(self) -> None:
        try:
            self.settings_file.write_text(json.dumps(self.settings, ensure_ascii=True, indent=2), encoding="utf-8")
        except Exception as exc:
            logging.warning("Failed to persist settings to %s: %s", self.settings_file, exc)

    def get_settings_payload(self) -> dict[str, Any]:
        return {
            "type": "SETTINGS_DATA",
            "settings": self._copy_settings(self.settings),
            "savedAt": self._iso_from_timestamp(datetime.now(timezone.utc).timestamp()),
            "source": str(self.settings_file),
        }

    @staticmethod
    def _coerce_hardware_value(value: Any, expected_type: str) -> Any:
        if expected_type == "bool":
            if isinstance(value, bool):
                return value
            if isinstance(value, str):
                lowered = value.strip().lower()
                if lowered in {"1", "true", "yes", "on"}:
                    return True
                if lowered in {"0", "false", "no", "off", ""}:
                    return False
            return bool(value)

        if expected_type == "int":
            return int(float(value))

        if expected_type == "float":
            return float(value)

        if expected_type == "enum":
            return str(value).strip().upper()

        if expected_type == "str":
            return str(value)

        return value

    def _apply_settings_to_local_hardware(self, patch: dict[str, Any]) -> dict[str, Any]:
        iface = self.conn.iface
        if not iface or not iface.isConnected.is_set():
            return {
                "connected": False,
                "applied": False,
                "appliedSections": [],
                "appliedFields": [],
                "unsupportedFields": [],
                "errors": ["Meshtastic interface is not connected"],
            }

        local_node = getattr(iface, "localNode", None)
        if local_node is None:
            return {
                "connected": True,
                "applied": False,
                "appliedSections": [],
                "appliedFields": [],
                "unsupportedFields": [],
                "errors": ["Local node is not ready"],
            }

        try:
            from meshtastic.__main__ import setPref  # type: ignore
        except Exception as exc:
            return {
                "connected": True,
                "applied": False,
                "appliedSections": [],
                "appliedFields": [],
                "unsupportedFields": [],
                "errors": [f"Unable to import Meshtastic setPref helper: {exc}"],
            }

        applied_sections: set[str] = set()
        applied_fields: list[str] = []
        unsupported_fields: list[str] = []
        errors: list[str] = []
        sections_to_write: set[str] = set()

        for section, raw_values in patch.items():
            if section not in HARDWARE_APPLY_FIELD_MAP:
                continue
            if not isinstance(raw_values, dict):
                continue

            field_map = HARDWARE_APPLY_FIELD_MAP[section]
            for ui_key, raw_value in raw_values.items():
                mapping = field_map.get(ui_key)
                if not mapping:
                    unsupported_fields.append(f"{section}.{ui_key}")
                    continue

                if section == "position" and ui_key == "fixedPosition":
                    unsupported_fields.append("position.fixedPosition (use location:set/location:clear)")
                    continue

                pref_name, expected_type = mapping
                pref_path = f"{section}.{pref_name}"
                try:
                    coerced = self._coerce_hardware_value(raw_value, expected_type)
                except Exception as exc:
                    errors.append(f"{section}.{ui_key}: invalid value ({exc})")
                    continue

                try:
                    ok = bool(setPref(local_node.localConfig, pref_path, coerced))
                except SystemExit as exc:
                    ok = False
                    errors.append(f"{section}.{ui_key}: rejected by Meshtastic ({exc})")
                except Exception as exc:
                    ok = False
                    errors.append(f"{section}.{ui_key}: {exc}")

                if not ok:
                    unsupported_fields.append(f"{section}.{ui_key}")
                    continue

                applied_sections.add(section)
                applied_fields.append(f"{section}.{ui_key}")
                sections_to_write.add(section)

        if sections_to_write:
            ordered_sections = sorted(sections_to_write)
            use_transaction = len(ordered_sections) > 1
            try:
                if use_transaction:
                    local_node.beginSettingsTransaction()
                    time.sleep(0.1)

                for section in ordered_sections:
                    local_node.writeConfig(section)
                    time.sleep(0.05)

                if use_transaction:
                    local_node.commitSettingsTransaction()
            except Exception as exc:
                errors.append(f"writeConfig failed: {exc}")

        return {
            "connected": True,
            "applied": bool(applied_fields) and not errors,
            "appliedSections": sorted(applied_sections),
            "appliedFields": applied_fields,
            "unsupportedFields": unsupported_fields,
            "errors": errors,
        }

    async def apply_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        merged = self._merge_settings(self.settings, patch)
        self.settings = self._sanitize_settings(merged)
        self._save_settings_to_disk()
        hardware_apply = await asyncio.to_thread(self._apply_settings_to_local_hardware, patch)
        payload = self.get_settings_payload()
        payload["hardwareApply"] = hardware_apply
        return payload

    @staticmethod
    def _is_valid_lat_lng(lat: Any, lng: Any) -> bool:
        try:
            lat_f = float(lat)
            lng_f = float(lng)
        except (TypeError, ValueError):
            return False
        if lat_f != lat_f or lng_f != lng_f:
            return False
        return -90.0 <= lat_f <= 90.0 and -180.0 <= lng_f <= 180.0

    def _sanitize_node_locations(self, candidate: Any) -> dict[str, dict[str, Any]]:
        if not isinstance(candidate, dict):
            return {}

        sanitized: dict[str, dict[str, Any]] = {}
        for raw_node_id, raw_info in candidate.items():
            node_id = self._normalize_node_id(raw_node_id)
            if not node_id or not isinstance(raw_info, dict):
                continue

            lat = self._safe_float(raw_info.get("lat"))
            lng = self._safe_float(raw_info.get("lng"))
            if not self._is_valid_lat_lng(lat, lng):
                continue

            sanitized[node_id] = {
                "nodeId": node_id,
                "lat": float(lat),
                "lng": float(lng),
                "name": str(raw_info.get("name") or "").strip(),
                "updatedAt": str(raw_info.get("updatedAt") or self._iso_from_timestamp(datetime.now(timezone.utc).timestamp())).strip(),
            }

        return sanitized

    def _save_node_locations_to_disk(self) -> None:
        try:
            self.node_locations_file.write_text(
                json.dumps(self.node_locations, ensure_ascii=True, indent=2),
                encoding="utf-8",
            )
        except Exception as exc:
            logging.warning("Failed to persist fixed node locations to %s: %s", self.node_locations_file, exc)

    def _load_node_locations_from_disk(self) -> None:
        try:
            if self.node_locations_file.exists():
                loaded = json.loads(self.node_locations_file.read_text(encoding="utf-8"))
                self.node_locations = self._sanitize_node_locations(loaded)
            else:
                self.node_locations = {}
                self._save_node_locations_to_disk()
        except Exception as exc:
            logging.warning("Failed to load fixed node locations from %s: %s", self.node_locations_file, exc)
            self.node_locations = {}

    def get_node_locations_payload(self) -> dict[str, Any]:
        local_node_id = self._local_node_id()
        locations: dict[str, dict[str, Any]] = {}
        if local_node_id and local_node_id in self.node_locations:
            locations[local_node_id] = copy.deepcopy(self.node_locations[local_node_id])
        return {
            "type": "FIXED_LOCATIONS_DATA",
            "locations": locations,
            "savedAt": self._iso_from_timestamp(datetime.now(timezone.utc).timestamp()),
            "source": str(self.node_locations_file),
        }

    async def set_node_fixed_location(self, node_id: Any, lat: Any, lng: Any, name: Any = None) -> dict[str, Any]:
        local_node_id = self._local_node_id()
        if not local_node_id:
            raise ValueError("Local node is not ready")

        normalized_id = self._normalize_node_id(node_id) if node_id is not None else local_node_id
        if normalized_id and normalized_id not in {local_node_id, str(LOCAL_ADDR)}:
            raise ValueError("Fixed position can only be set on the connected local node")

        lat_f = self._safe_float(lat)
        lng_f = self._safe_float(lng)
        if not self._is_valid_lat_lng(lat_f, lng_f):
            raise ValueError("Invalid lat/lng")

        iface = self.conn.iface
        if not iface or not iface.isConnected.is_set():
            raise ValueError("Meshtastic interface is not connected")

        try:
            await asyncio.to_thread(iface.localNode.setFixedPosition, float(lat_f), float(lng_f), 0)
        except Exception as exc:
            logging.warning("Failed to apply fixed position to local node: %s", exc)
            raise ValueError("Failed to apply fixed position to the local node") from exc

        now_iso = self._iso_from_timestamp(datetime.now(timezone.utc).timestamp())
        node_name = str(name or self._node_name_by_id(local_node_id) or "").strip()
        self.node_locations = {
            local_node_id: {
                "nodeId": local_node_id,
                "lat": float(lat_f),
                "lng": float(lng_f),
                "name": node_name,
                "updatedAt": now_iso,
            }
        }
        self._save_node_locations_to_disk()

        if local_node_id in self.nodes:
            self.nodes[local_node_id]["lat"] = float(lat_f)
            self.nodes[local_node_id]["lng"] = float(lng_f)
            self.nodes[local_node_id].setdefault("raw", {})
            self.nodes[local_node_id]["raw"]["fixedLocation"] = True
            self.nodes[local_node_id]["lastUpdated"] = now_iso

        return {
            "type": "FIXED_LOCATION_UPDATED",
            "nodeId": local_node_id,
            "location": copy.deepcopy(self.node_locations[local_node_id]),
        }

    async def clear_node_fixed_location(self, node_id: Any) -> dict[str, Any]:
        local_node_id = self._local_node_id()
        if not local_node_id:
            raise ValueError("Local node is not ready")

        normalized_id = self._normalize_node_id(node_id) if node_id is not None else local_node_id
        if normalized_id and normalized_id not in {local_node_id, str(LOCAL_ADDR)}:
            raise ValueError("Fixed position can only be cleared on the connected local node")

        iface = self.conn.iface
        if not iface or not iface.isConnected.is_set():
            raise ValueError("Meshtastic interface is not connected")

        try:
            await asyncio.to_thread(iface.localNode.removeFixedPosition)
        except Exception as exc:
            logging.warning("Failed to remove fixed position from local node: %s", exc)
            raise ValueError("Failed to clear the fixed position on the local node") from exc

        removed = self.node_locations.pop(local_node_id, None)
        self._save_node_locations_to_disk()

        if local_node_id in self.nodes:
            self.nodes[local_node_id].setdefault("raw", {})
            self.nodes[local_node_id]["raw"]["fixedLocation"] = False

        return {
            "type": "FIXED_LOCATION_CLEARED",
            "nodeId": local_node_id,
            "removed": bool(removed),
        }

    def _parse_hwid_pair(self, hwid_text: str) -> Optional[tuple[int, int]]:
        match = re.search(r"VID:PID=([0-9A-Fa-f]{4}):([0-9A-Fa-f]{4})", hwid_text)
        if not match:
            return None
        return int(match.group(1), 16), int(match.group(2), 16)

    def _match_board(self, port_info: dict[str, Any]) -> Optional[dict[str, str]]:
        pair = self._parse_hwid_pair(str(port_info.get("hwid") or ""))
        if not pair:
            return None
        return self.known_hwids.get(pair)

    def _port_score(self, port_info: dict[str, Any]) -> int:
        text = " ".join(
            [
                str(port_info.get("description", "")),
                str(port_info.get("manufacturer", "")),
                str(port_info.get("hwid", "")),
                str(port_info.get("device", "")),
                str(port_info.get("matched_board", "")),
                str(port_info.get("matched_vendor", "")),
            ]
        ).lower()

        score = 0
        for token in self.known_tokens:
            if token in text:
                score += 2

        if port_info.get("hwid_matched"):
            score += 8

        if port_info.get("device", "").upper().startswith("COM"):
            score += 1

        return score

    def list_ports_payload(self) -> list[dict[str, Any]]:
        ports = []
        for p in list_ports.comports():
            payload = {
                "device": p.device,
                "description": p.description or "Unknown device",
                "manufacturer": p.manufacturer or "",
                "hwid": p.hwid or "",
            }

            board_match = self._match_board(payload)
            if board_match:
                payload["hwid_matched"] = True
                payload["matched_board"] = board_match.get("name", "")
                payload["matched_vendor"] = board_match.get("vendor", "")
                payload["matched_usb_product"] = board_match.get("usb_product", "")
            else:
                payload["hwid_matched"] = False

            payload["score"] = self._port_score(payload)
            payload["is_heltec"] = payload["score"] >= 2
            ports.append(payload)

        ports.sort(key=lambda item: (item.get("score", 0), item.get("device", "")), reverse=True)
        return ports

    def best_port(self) -> Optional[str]:
        ports = self.list_ports_payload()
        if not ports:
            return None
        return ports[0]["device"]

    @staticmethod
    def _safe_float(value: Any) -> Optional[float]:
        try:
            result = float(value)
            if result != result:
                return None
            return result
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _iso_from_timestamp(value: Any) -> str:
        try:
            ts = float(value)
            return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
        except (TypeError, ValueError, OSError):
            return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _normalize_node_id(value: Any) -> str:
        text = str(value or "").strip().lower()
        if not text:
            return ""
        if text.startswith("!"):
            return text
        if re.fullmatch(r"[0-9a-f]{8}", text):
            return f"!{text}"
        return text

    def _dynamic_excluded_suffixes(self) -> set[str]:
        text = str((self.settings.get("module") or {}).get("nodeBlackListSuffixes") or "")
        dynamic = {
            token.strip().lower().lstrip("!")
            for token in text.split(",")
            if token.strip()
        }
        return {item for item in dynamic if re.fullmatch(r"[0-9a-f]{4}", item)}

    def _is_excluded_node_id(self, value: Any) -> bool:
        normalized = self._normalize_node_id(value)
        if not normalized:
            return False

        if normalized in EXCLUDED_NODE_IDS:
            return True

        suffixes = EXCLUDED_NODE_SUFFIXES.union(self._dynamic_excluded_suffixes())

        if normalized.startswith("!") and len(normalized) >= 5:
            return normalized[-4:] in suffixes

        return normalized in suffixes

    def _normalize_node(self, node: dict[str, Any]) -> Optional[dict[str, Any]]:
        node_num = node.get("num")
        user = node.get("user") or {}
        node_id = user.get("id")

        if not node_id and isinstance(node_num, int):
            node_id = f"!{node_num:08x}"

        if not node_id:
            return None

        if self._is_excluded_node_id(node_id):
            return None

        previous_node = self.nodes.get(str(node_id)) or {}
        activity_ts = self.node_activity.get(str(node_id))

        position = node.get("position") or {}
        lat = self._safe_float(position.get("latitude"))
        lng = self._safe_float(position.get("longitude"))

        if lat is None:
            lat_i = self._safe_float(position.get("latitudeI"))
            if lat_i is not None:
                lat = lat_i * 1e-7

        if lng is None:
            lng_i = self._safe_float(position.get("longitudeI"))
            if lng_i is not None:
                lng = lng_i * 1e-7

        fixed_location = self.node_locations.get(str(node_id))
        if fixed_location:
            fixed_lat = self._safe_float(fixed_location.get("lat"))
            fixed_lng = self._safe_float(fixed_location.get("lng"))
            if self._is_valid_lat_lng(fixed_lat, fixed_lng):
                lat = float(fixed_lat)
                lng = float(fixed_lng)

        metrics = node.get("deviceMetrics") or {}
        battery = self._safe_float(metrics.get("batteryLevel"))

        rssi = self._safe_float(node.get("rxRssi"))
        if rssi is None:
            rssi = self._safe_float(node.get("snr"))

        local_num = self.conn.iface.myInfo.my_node_num if (self.conn.iface and self.conn.iface.myInfo) else None
        node_type = "gateway" if (local_num is not None and node_num == local_num) else "alarm"

        last_heard = self._safe_float(node.get("lastHeard"))
        now = datetime.now(timezone.utc).timestamp()

        # Gateway node should stay online while serial link is up.
        if node_type == "gateway":
            status = "online"
            last_updated_iso = self._iso_from_timestamp(last_heard if last_heard is not None else now)
        else:
            source_ts = activity_ts if activity_ts is not None else last_heard
            previous_ts = self._timestamp_from_iso(previous_node.get("lastUpdated"))
            display_ts = source_ts if source_ts is not None else previous_ts

            if source_ts is None:
                status = "offline"
            else:
                status = "online" if (now - source_ts) <= ONLINE_WINDOW_SECONDS else "offline"

            if display_ts is None:
                display_ts = now
            last_updated_iso = self._iso_from_timestamp(display_ts)

        return {
            "id": node_id,
            "name": user.get("longName") or user.get("shortName") or node_id,
            "lat": lat,
            "lng": lng,
            "status": status,
            "type": node_type,
            "battery": battery,
            "rssi": rssi,
            "lastUpdated": last_updated_iso,
            "raw": {
                "num": node_num,
                "shortName": user.get("shortName"),
                "hwModel": user.get("hwModel"),
                "hasLastHeard": last_heard is not None,
                "lastHeard": last_heard,
                "fixedLocation": bool(fixed_location),
            },
        }

    def _refresh_nodes_from_interface(self) -> None:
        iface = self.conn.iface
        if not iface:
            logging.debug("No interface to refresh nodes")
            self.nodes = {}
            return

        updated: dict[str, dict[str, Any]] = {}

        # Primary source: nodesByNum generally contains all known nodes (local + remote).
        nodes_by_num = iface.nodesByNum or {}
        nodes_dict = iface.nodes or {}
        logging.info(
            "Refreshing nodes: nodesByNum=%s, interface.nodes=%s",
            len(nodes_by_num),
            len(nodes_dict),
        )

        for node_num, node in nodes_by_num.items():
            if not isinstance(node, dict):
                logging.debug("Skipping non-dict nodeByNum %s: %s", node_num, type(node))
                continue

            normalized = self._normalize_node(node)
            if normalized:
                updated[normalized["id"]] = normalized

        # Fallback source: include any additional node from interface.nodes.
        for node_id, node in nodes_dict.items():
            if not isinstance(node, dict):
                logging.debug("Skipping non-dict node %s: %s", node_id, type(node))
                continue

            normalized = self._normalize_node(node)
            if normalized:
                updated.setdefault(normalized["id"], normalized)

        # Keep best-known runtime metrics for nodes that do not always expose
        # deviceMetrics in nodesByNum.
        for node_id, old_node in self.nodes.items():
            current = updated.get(node_id)
            if not current:
                continue

            if current.get("battery") is None and old_node.get("battery") is not None:
                current["battery"] = old_node.get("battery")

            if current.get("rssi") is None and old_node.get("rssi") is not None:
                current["rssi"] = old_node.get("rssi")

            if old_node.get("lastUpdated") and (current.get("lastUpdated") or "") < old_node.get("lastUpdated"):
                current["lastUpdated"] = old_node.get("lastUpdated")

        logging.info("Final node count: %s", len(updated))

        local_node_id = self._local_node_id()
        if local_node_id and local_node_id not in updated:
            location = self.node_locations.get(local_node_id)
            lat = self._safe_float((location or {}).get("lat"))
            lng = self._safe_float((location or {}).get("lng"))
            if self._is_valid_lat_lng(lat, lng):
                updated[local_node_id] = {
                    "id": local_node_id,
                    "name": str((location or {}).get("name") or local_node_id),
                    "lat": float(lat),
                    "lng": float(lng),
                    "status": "offline",
                    "type": "gateway",
                    "battery": None,
                    "rssi": None,
                    "lastUpdated": str((location or {}).get("updatedAt") or self._iso_from_timestamp(datetime.now(timezone.utc).timestamp())),
                    "raw": {
                        "num": None,
                        "shortName": None,
                        "hwModel": None,
                        "hasLastHeard": False,
                        "fixedLocation": True,
                    },
                }

        self.nodes = updated

    @staticmethod
    def _packet_sender_id(packet: dict[str, Any]) -> Optional[str]:
        from_id = packet.get("fromId")
        if isinstance(from_id, str) and from_id.strip():
            return from_id.strip()

        from_num = packet.get("from")
        if isinstance(from_num, int):
            return f"!{from_num:08x}"

        return None

    def _record_node_activity(self, node_id: Optional[str], timestamp: Optional[float] = None) -> None:
        if not node_id:
            return
        self.node_activity[str(node_id)] = float(timestamp if timestamp is not None else datetime.now(timezone.utc).timestamp())

    def _extract_packet_metrics(self, packet: dict[str, Any]) -> tuple[Optional[float], Optional[float], float]:
        decoded = packet.get("decoded") or {}

        telemetry = decoded.get("telemetry") if isinstance(decoded, dict) else None
        device_metrics = {}
        if isinstance(telemetry, dict):
            if isinstance(telemetry.get("deviceMetrics"), dict):
                device_metrics = telemetry.get("deviceMetrics") or {}
            elif isinstance(telemetry.get("device_metrics"), dict):
                device_metrics = telemetry.get("device_metrics") or {}
            else:
                device_metrics = telemetry

        battery = self._safe_float(device_metrics.get("batteryLevel"))
        if battery is None:
            battery = self._safe_float(device_metrics.get("battery_level"))

        rssi = self._safe_float(packet.get("rxRssi"))
        if rssi is None:
            rssi = self._safe_float(packet.get("rx_rssi"))
        if rssi is None:
            rssi = self._safe_float(packet.get("rxSnr"))
        if rssi is None:
            rssi = self._safe_float(packet.get("rx_snr"))

        rx_time = self._safe_float(packet.get("rxTime"))
        if rx_time is None:
            rx_time = self._safe_float(packet.get("rx_time"))
        if rx_time is None:
            rx_time = datetime.now(timezone.utc).timestamp()

        return battery, rssi, rx_time

    @staticmethod
    def _extract_packet_text(packet: dict[str, Any]) -> Optional[str]:
        decoded = packet.get("decoded") or {}
        if isinstance(decoded, dict):
            text = decoded.get("text")
            if isinstance(text, str) and text.strip():
                return text.strip()

            payload = decoded.get("payload")
            if isinstance(payload, str) and payload.strip():
                return payload.strip()

        return None

    def _recompute_node_statuses(self, now_ts: Optional[float] = None) -> bool:
        now = float(now_ts if now_ts is not None else datetime.now(timezone.utc).timestamp())
        changed = False

        for node_id, node in self.nodes.items():
            node_type = str(node.get("type") or "").lower()
            if node_type == "gateway":
                desired_status = "online" if (self.conn.iface and self.conn.iface.isConnected.is_set()) else "offline"
            else:
                activity_ts = self.node_activity.get(node_id)
                if activity_ts is None:
                    activity_ts = self._safe_float((node.get("raw") or {}).get("lastHeard"))
                if activity_ts is None:
                    desired_status = "offline"
                else:
                    desired_status = "online" if (now - activity_ts) <= ONLINE_WINDOW_SECONDS else "offline"

            current_status = str(node.get("status") or "offline").lower()
            if desired_status != current_status:
                node["status"] = desired_status
                changed = True

        return changed

    async def broadcast_incoming_message(self, payload: dict[str, Any]) -> None:
        await self.broadcast_json({"type": "mesh:receive", **payload})

    async def broadcast_mesh_ack(self, payload: dict[str, Any]) -> None:
        await self.broadcast_json({"type": "mesh:ack", **payload})

    async def broadcast_command_delivery(self, payload: dict[str, Any]) -> None:
        await self.broadcast_json({"type": "command:delivery", **payload})

    def _register_pending_command(
        self,
        packet_id: Optional[int],
        request_id: Any,
        destination: Any,
        text: str,
        retry_count: int = 0,
    ) -> None:
        if not isinstance(packet_id, int):
            return
        self.pending_commands[packet_id] = {
            "packetId": packet_id,
            "requestId": request_id,
            "destination": destination,
            "destinationName": self._node_name_by_id(destination),
            "text": text,
            "createdAt": datetime.now(timezone.utc).timestamp(),
            "status": "pending",
            "retryCount": int(max(0, retry_count)),
        }

    async def _retry_pending_command(self, pending: dict[str, Any]) -> Optional[dict[str, Any]]:
        iface = self.conn.iface
        if not iface or not iface.isConnected.is_set():
            return None

        destination = pending.get("destination")
        if destination in {BROADCAST_ADDR, LOCAL_ADDR}:
            return None

        retry_count = int(pending.get("retryCount") or 0)
        if retry_count >= PENDING_TIMEOUT_RETRIES:
            return None

        text = str(pending.get("text") or "").strip() or "BAODONG"
        await asyncio.sleep(max(0.0, PENDING_RETRY_GAP_SECONDS))

        async with self.lock:
            iface = self.conn.iface
            if not iface or not iface.isConnected.is_set():
                return None

            try:
                sent_packet = await asyncio.to_thread(
                    iface.sendText,
                    text,
                    destination,
                    True,
                    True,
                )
            except Exception:
                return None

        packet_id = getattr(sent_packet, "id", None)
        if not isinstance(packet_id, int):
            return None

        self._register_pending_command(
            packet_id,
            pending.get("requestId"),
            destination,
            text,
            retry_count=retry_count + 1,
        )

        return {
            "packetId": packet_id,
            "requestId": pending.get("requestId"),
            "destination": destination,
            "destinationName": self._node_name_by_id(destination),
            "text": text,
            "status": "pending",
            "retryCount": retry_count + 1,
            "errorReason": f"RETRY_{retry_count + 1}",
            "resolvedAt": self._iso_from_timestamp(datetime.now(timezone.utc).timestamp()),
        }

    def _consume_pending_command(self, packet_id: Any) -> Optional[dict[str, Any]]:
        candidate: Optional[int] = None
        if isinstance(packet_id, int):
            candidate = packet_id
        elif isinstance(packet_id, str):
            text = packet_id.strip().lower()
            if text.startswith("0x"):
                try:
                    candidate = int(text, 16)
                except ValueError:
                    candidate = None
            elif text.isdigit():
                candidate = int(text)

        if candidate is None:
            return None
        return self.pending_commands.pop(candidate, None)

    def _consume_pending_by_destination(
        self,
        destination_id: Any,
        max_age_seconds: Optional[float] = None,
    ) -> Optional[dict[str, Any]]:
        key = str(destination_id or "").strip()
        if not key:
            return None

        now_ts = datetime.now(timezone.utc).timestamp()
        selected_packet_id: Optional[int] = None
        selected_created_at: Optional[float] = None

        for packet_id, pending in self.pending_commands.items():
            destination = str(pending.get("destination") or "").strip()
            if destination != key:
                continue

            created_at = float(pending.get("createdAt") or now_ts)
            if max_age_seconds is not None and (now_ts - created_at) > max_age_seconds:
                continue

            if selected_packet_id is None or (selected_created_at is not None and created_at < selected_created_at):
                selected_packet_id = packet_id
                selected_created_at = created_at

        if selected_packet_id is None:
            return None

        return self.pending_commands.pop(selected_packet_id, None)

    def _schedule_coroutine(self, coro_func, *args) -> None:
        if not self.loop:
            return

        def _runner() -> None:
            asyncio.create_task(coro_func(*args))

        self.loop.call_soon_threadsafe(_runner)

    def _on_connection_established(self, interface: SerialInterface) -> None:
        if interface is not self.conn.iface:
            return
        logging.info("Meshtastic connection established on %s", self.conn.port_name)
        logging.info(f"Interface info - nodes count: {len(interface.nodes or {})}, nodesByNum count: {len(interface.nodesByNum or {})}")
        
        if interface.nodesByNum:
            for num, node_info in interface.nodesByNum.items():
                node_id = (node_info or {}).get('user', {}).get('id', 'N/A')
                node_name = (node_info or {}).get('user', {}).get('longName', 'Unknown')
                logging.info(f"  Known node: num={num}, id={node_id}, name={node_name}")
        
        self._refresh_nodes_from_interface()
        self._schedule_coroutine(self.send_connection_status, "connected")
        self._schedule_coroutine(self.broadcast_nodes)

    def _on_connection_lost(self, interface: SerialInterface) -> None:
        if interface is not self.conn.iface:
            return
        logging.warning("Meshtastic connection lost on %s", self.conn.port_name)
        self._schedule_coroutine(self.send_connection_status, "scanning")

    def _on_node_updated(self, node: dict[str, Any], interface: SerialInterface) -> None:
        if interface is not self.conn.iface:
            logging.debug("Node update from wrong interface, ignoring")
            return

        node_num = node.get("num")
        logging.info(f"Node updated event - node_num: {node_num}, user_id: {node.get('user', {}).get('id')}")
        node_id = (node.get("user") or {}).get("id") or self._node_id_from_num(node_num)
        if self._is_excluded_node_id(node_id):
            self.node_activity.pop(str(node_id), None)
            self.nodes.pop(str(node_id), None)
            return

        self._record_node_activity(node_id, self._safe_float(node.get("lastHeard")))
        normalized = self._normalize_node(node)
        if not normalized:
            logging.warning(f"Failed to normalize node {node_num}")
            return

        self.nodes[normalized["id"]] = normalized
        logging.info(f"Stored node: {normalized['id']} - {normalized.get('name')}. Total nodes now: {len(self.nodes)}")
        self._schedule_coroutine(self.broadcast_node_update, normalized)

    def _on_receive_packet(self, packet: dict[str, Any], interface: SerialInterface) -> None:
        if interface is not self.conn.iface:
            return

        updated_any = False
        from_id = self._packet_sender_id(packet)
        if self._is_excluded_node_id(from_id):
            return

        battery, rssi, rx_time = self._extract_packet_metrics(packet)
        text = self._extract_packet_text(packet)

        self._record_node_activity(from_id, rx_time)

        if from_id and from_id in self.nodes:
            self.nodes[from_id]["lastUpdated"] = self._iso_from_timestamp(rx_time)
            self.nodes[from_id]["status"] = "online"
            if battery is not None:
                self.nodes[from_id]["battery"] = battery
            if rssi is not None:
                self.nodes[from_id]["rssi"] = rssi
            updated_any = True
        elif from_id:
            # New sender might not have been normalized yet; refresh from interface DB.
            self._refresh_nodes_from_interface()
            if from_id in self.nodes:
                self.nodes[from_id]["lastUpdated"] = self._iso_from_timestamp(rx_time)
                self.nodes[from_id]["status"] = "online"
                if battery is not None:
                    self.nodes[from_id]["battery"] = battery
                if rssi is not None:
                    self.nodes[from_id]["rssi"] = rssi
                updated_any = True
            else:
                self.nodes[from_id] = {
                    "id": from_id,
                    "name": from_id,
                    "lat": None,
                    "lng": None,
                    "status": "online",
                    "type": "alarm",
                    "battery": battery,
                    "rssi": rssi,
                    "lastUpdated": self._iso_from_timestamp(rx_time),
                    "raw": {"num": packet.get("from")},
                }
                updated_any = True

        if updated_any:
            self._schedule_coroutine(self.broadcast_nodes)

        decoded = packet.get("decoded") or {}
        consumed_pending = False
        routing = decoded.get("routing") if isinstance(decoded, dict) else None
        if isinstance(routing, dict):
            request_id = routing.get("requestId") or packet.get("requestId")
            error_reason = routing.get("errorReason") or "NONE"

            self._schedule_coroutine(
                self.broadcast_mesh_ack,
                {
                    "fromId": from_id,
                    "toId": packet.get("toId"),
                    "requestId": request_id,
                    "errorReason": error_reason,
                    "rxTime": self._iso_from_timestamp(rx_time),
                    "portnum": decoded.get("portnum"),
                },
            )

            pending = self._consume_pending_command(request_id)
            if pending:
                consumed_pending = True
                normalized_reason = str(error_reason).upper()
                delivery_status = "delivered" if normalized_reason in {"NONE", "0"} else "failed"
                self._schedule_coroutine(
                    self.broadcast_command_delivery,
                    {
                        **pending,
                        "status": delivery_status,
                        "ackFrom": from_id,
                        "errorReason": error_reason,
                        "resolvedAt": self._iso_from_timestamp(rx_time),
                    },
                )

        # Some nodes do not return routing ACK but still emit telemetry/text soon after receiving command.
        # Treat that as delivery confirmation to avoid false ACK_TIMEOUT misses.
        if from_id and not consumed_pending:
            pending_by_sender = self._consume_pending_by_destination(from_id, ACK_TIMEOUT_SECONDS)
            if pending_by_sender:
                self._schedule_coroutine(
                    self.broadcast_command_delivery,
                    {
                        **pending_by_sender,
                        "status": "delivered",
                        "ackFrom": from_id,
                        "errorReason": "PACKET_RESPONSE",
                        "resolvedAt": self._iso_from_timestamp(rx_time),
                    },
                )

        # Push incoming packet event to UI so operators can see node feedback.
        if from_id:
            self._schedule_coroutine(
                self.broadcast_incoming_message,
                {
                    "fromId": from_id,
                    "fromName": self._node_name_by_id(from_id),
                    "toId": packet.get("toId"),
                    "text": text,
                    "rxRssi": rssi,
                    "rxTime": self._iso_from_timestamp(rx_time),
                    "portnum": ((packet.get("decoded") or {}).get("portnum")),
                },
            )

    def _subscribe_meshtastic_events(self) -> None:
        if self._subscribed:
            return
        pub.subscribe(self._cb_connection_established, "meshtastic.connection.established")
        pub.subscribe(self._cb_connection_lost, "meshtastic.connection.lost")
        pub.subscribe(self._cb_node_updated, "meshtastic.node.updated")
        pub.subscribe(self._cb_receive, "meshtastic.receive")
        self._subscribed = True

    def _unsubscribe_meshtastic_events(self) -> None:
        if not self._subscribed:
            return

        try:
            pub.unsubscribe(self._cb_connection_established, "meshtastic.connection.established")
            pub.unsubscribe(self._cb_connection_lost, "meshtastic.connection.lost")
            pub.unsubscribe(self._cb_node_updated, "meshtastic.node.updated")
            pub.unsubscribe(self._cb_receive, "meshtastic.receive")
        except Exception:
            pass

        self._subscribed = False

    async def send_json(self, ws: WebSocketServerProtocol, payload: dict[str, Any]) -> None:
        await ws.send(json.dumps(payload, ensure_ascii=True))

    async def broadcast_json(self, payload: dict[str, Any]) -> None:
        if not self.clients:
            return

        stale_clients: list[WebSocketServerProtocol] = []
        message = json.dumps(payload, ensure_ascii=True)
        for client in self.clients:
            try:
                await client.send(message)
            except Exception:
                stale_clients.append(client)

        for client in stale_clients:
            self.clients.discard(client)

    async def broadcast_nodes(self) -> None:
        await self.broadcast_json({"type": "nodes:update", "nodes": list(self.nodes.values())})

    async def broadcast_node_update(self, node: dict[str, Any]) -> None:
        await self.broadcast_json({"type": "NODE_UPDATE", "data": node})

    async def send_port_list(self, ws: WebSocketServerProtocol) -> None:
        await self.send_json(ws, {"type": "PORT_LIST", "ports": self.list_ports_payload()})

    async def _close_current_interface(self) -> None:
        iface = self.conn.iface
        if iface:
            try:
                await asyncio.to_thread(iface.close)
            except Exception:
                pass
        self.conn.iface = None
        self.conn.port_name = None
        self.nodes = {}
        self.node_activity = {}

    async def connect_port(self, port_name: str) -> tuple[bool, str]:
        async with self.lock:
            if self.conn.iface and self.conn.port_name == port_name and self.conn.iface.isConnected.is_set():
                return True, f"Already connected to {port_name}"

            await self._close_current_interface()

            try:
                self._subscribe_meshtastic_events()
                iface = await asyncio.to_thread(SerialInterface, devPath=port_name, noProto=False, noNodes=False, timeout=30)
                self.conn.iface = iface
                self.conn.port_name = port_name
                self.last_connect_error = None
                logging.info("Connected Meshtastic interface on %s (waiting for nodeDB...)", port_name)
                
                # Wait for nodeDB to start populating (up to 8 seconds)
                for attempt in range(40):
                    await asyncio.sleep(0.2)
                    node_count = len(iface.nodes or {})
                    if node_count > 0:
                        logging.info(f"NodeDB populated with {node_count} nodes after {attempt * 0.2:.1f}s")
                        break
                
                self._refresh_nodes_from_interface()
                logging.info("Connected Meshtastic interface on %s", port_name)
                return True, f"Connected to {port_name}"
            except Exception as exc:
                raw_message = str(exc)
                if "access is denied" in raw_message.lower() or "permissionerror" in raw_message.lower():
                    message = (
                        f"Cannot connect {port_name}: Access is denied. "
                        "Another app is using this COM port (Meshtastic app, serial monitor, etc.)."
                    )
                else:
                    message = f"Cannot connect {port_name}: {exc}"

                if message != self.last_connect_error:
                    logging.warning(message)
                    self.last_connect_error = message

                await self._close_current_interface()
                self._unsubscribe_meshtastic_events()
                return False, message

    async def disconnect_if_missing(self) -> None:
        async with self.lock:
            if not self.conn.iface or not self.conn.port_name:
                return

            devices = {p.device for p in list_ports.comports()}
            if self.conn.port_name in devices and self.conn.iface.isConnected.is_set():
                return

            logging.warning("Serial port %s is gone or disconnected", self.conn.port_name)
            await self._close_current_interface()
            await self.send_connection_status("scanning")

    async def send_connection_status(self, status: str) -> None:
        await self.broadcast_json(
            {
                "type": "CONNECTION_STATUS",
                "status": status,
                "port": self.conn.port_name,
            }
        )

    @staticmethod
    def _resolve_destination(target_id: Any) -> Any:
        if target_id is None:
            return BROADCAST_ADDR

        text = str(target_id).strip()
        if not text:
            return BROADCAST_ADDR

        lowered = text.lower()
        if lowered in {"^all", "all", "broadcast", "*"}:
            return BROADCAST_ADDR

        if lowered in {"^local", "local", "self"}:
            return LOCAL_ADDR

        if re.fullmatch(r"!?[0-9a-fA-F]{8}", text):
            return text if text.startswith("!") else f"!{text}"

        if lowered.startswith("0x") and len(lowered) >= 3:
            try:
                return int(lowered, 16)
            except ValueError:
                return text

        if text.isdigit():
            try:
                return int(text)
            except ValueError:
                return text

        return text

    @staticmethod
    def _node_id_from_num(node_num: Any) -> Optional[str]:
        if isinstance(node_num, int):
            return f"!{node_num:08x}"
        return None

    def _local_node_id(self) -> Optional[str]:
        iface = self.conn.iface
        if iface and iface.myInfo:
            return self._node_id_from_num(iface.myInfo.my_node_num)
        return None

    def _node_name_by_id(self, node_id: Any) -> str:
        key = str(node_id or "").strip()
        if not key:
            return "unknown"

        known = self.nodes.get(key) or {}
        if known.get("name"):
            return str(known.get("name"))

        iface = self.conn.iface
        nodes_by_num = (iface.nodesByNum if iface else None) or {}
        for node_num, node in nodes_by_num.items():
            if not isinstance(node, dict):
                continue
            user = node.get("user") or {}
            candidate_id = user.get("id") or self._node_id_from_num(node_num)
            if candidate_id != key:
                continue
            return user.get("longName") or user.get("shortName") or key

        return key

    def _broadcast_targets(self) -> list[str]:
        iface = self.conn.iface
        local_node_id = None
        if iface and iface.myInfo:
            local_node_id = self._node_id_from_num(iface.myInfo.my_node_num)

        targets: list[str] = []
        seen: set[str] = set()

        # Primary source: meshtastic internal node DB (more reliable than status cache).
        nodes_by_num = (iface.nodesByNum if iface else None) or {}
        for node_num, node in nodes_by_num.items():
            if not isinstance(node, dict):
                continue
            user = node.get("user") or {}
            node_id = user.get("id") or self._node_id_from_num(node_num)
            cached = self.nodes.get(str(node_id or "")) or {}
            if (
                not node_id
                or node_id in seen
                or self._is_excluded_node_id(node_id)
            ):
                continue

            if local_node_id and node_id == local_node_id:
                continue

            # Fallback when myInfo is unavailable: rely on normalized cache to skip gateway node.
            if not local_node_id and str(cached.get("type") or "").lower() == "gateway":
                continue

            seen.add(node_id)
            targets.append(node_id)

        # Fallback source: current normalized cache.
        for node_id, node in self.nodes.items():
            if node_id == local_node_id or node_id in seen or self._is_excluded_node_id(node_id):
                continue
            if str((node or {}).get("type") or "").lower() == "gateway":
                continue
            seen.add(node_id)
            targets.append(node_id)

        return targets

    async def handle_command(self, ws: WebSocketServerProtocol, message: dict[str, Any]) -> None:
        request_id = message.get("requestId")
        text = (((message.get("payload") or {}).get("text")) or message.get("command") or "BAODONG").strip()
        target_id = (message.get("payload") or {}).get("targetId")
        destination = self._resolve_destination(target_id)

        if destination not in {BROADCAST_ADDR, LOCAL_ADDR} and self._is_excluded_node_id(destination):
            await self.send_json(
                ws,
                {
                    "type": "error",
                    "ok": False,
                    "requestId": request_id,
                    "error": "Target node is excluded from this deployment",
                },
            )
            return

        async with self.lock:
            iface = self.conn.iface
            if not iface or not iface.isConnected.is_set():
                await self.send_json(
                    ws,
                    {
                        "type": "error",
                        "ok": False,
                        "requestId": request_id,
                        "error": "Meshtastic interface is not connected",
                    },
                )
                return

            destinations: list[Any]
            if destination == BROADCAST_ADDR:
                fanout_targets = self._broadcast_targets()
                destinations = fanout_targets if fanout_targets else [destination]
                logging.info(
                    "Fanout request %s resolved %s target(s): %s",
                    request_id,
                    len(destinations),
                    [str(item) for item in destinations],
                )
            else:
                destinations = [destination]

            results: list[dict[str, Any]] = []
            for index, dst in enumerate(destinations):
                if destination == BROADCAST_ADDR and index > 0 and FANOUT_SEND_GAP_SECONDS > 0:
                    await asyncio.sleep(FANOUT_SEND_GAP_SECONDS)

                sent_packet = None
                send_error = None
                attempts = 1 + (FANOUT_RETRY_COUNT if destination == BROADCAST_ADDR else 0)
                for attempt in range(max(1, attempts)):
                    try:
                        sent_packet = await asyncio.to_thread(
                            iface.sendText,
                            text,
                            dst,
                            True,
                            True,
                        )
                        send_error = None
                        break
                    except Exception as exc:
                        send_error = str(exc)
                        if attempt + 1 < attempts:
                            await asyncio.sleep(0.15)

                if sent_packet is None:
                    results.append(
                        {
                            "ok": False,
                            "destination": dst,
                            "destinationName": self._node_name_by_id(dst),
                            "error": send_error or "Unknown send error",
                        }
                    )
                    continue

                packet_id = getattr(sent_packet, "id", None)
                self._register_pending_command(packet_id, request_id, dst, text)
                results.append(
                    {
                        "ok": True,
                        "destination": dst,
                        "destinationName": self._node_name_by_id(dst),
                        "packetId": packet_id,
                    }
                )

        ok_results = [item for item in results if item.get("ok")]
        if not ok_results:
            first_error = next((item.get("error") for item in results if item.get("error")), "Unknown error")
            await self.send_json(
                ws,
                {
                    "type": "error",
                    "ok": False,
                    "requestId": request_id,
                    "error": f"Meshtastic send failed: {first_error}",
                },
            )
            return

        for result in ok_results:
            ack_payload = {
                "type": "ack",
                "ok": True,
                "requestId": request_id,
                "packetId": result.get("packetId"),
                "destination": result.get("destination"),
                "destinationName": result.get("destinationName"),
                "message": f"Sent '{text}' to {result.get('destination')}",
                "ackSource": "gateway",
            }
            await self.send_json(ws, ack_payload)
            await self.broadcast_json({"type": "command:ack", **ack_payload})

        await self.send_json(
            ws,
            {
                "type": "command:summary",
                "requestId": request_id,
                "attempted": len(destinations),
                "sent": len(ok_results),
                "failed": len(results) - len(ok_results),
                "fanout": destination == BROADCAST_ADDR,
                "destinationsAttempted": [
                    {
                        "id": str(dst),
                        "name": self._node_name_by_id(dst),
                    }
                    for dst in destinations
                ],
                "destinations": [
                    {
                        "id": item.get("destination"),
                        "name": item.get("destinationName"),
                        "packetId": item.get("packetId"),
                    }
                    for item in ok_results
                ],
                "failedDestinations": [
                    {
                        "id": item.get("destination"),
                        "name": item.get("destinationName"),
                        "error": item.get("error"),
                    }
                    for item in results
                    if not item.get("ok")
                ],
            },
        )

    async def handle_message(self, ws: WebSocketServerProtocol, raw: str) -> None:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            await self.send_json(ws, {"type": "STATUS", "status": "error", "message": "Invalid JSON"})
            return

        msg_type = data.get("type")
        if msg_type == "GET_PORTS":
            await self.send_port_list(ws)
            return

        if msg_type == "CONNECT_PORT":
            target_port = data.get("port")
            if not target_port:
                await self.send_json(
                    ws,
                    {
                        "type": "STATUS",
                        "status": "error",
                        "message": "CONNECT_PORT requires 'port'",
                    },
                )
                return

            await self.send_connection_status("scanning")
            ok, message = await self.connect_port(target_port)
            if ok:
                await self.send_connection_status("connected")
                await self.broadcast_nodes()
            else:
                await self.send_json(ws, {"type": "STATUS", "status": "error", "message": message})
                await self.send_connection_status("scanning")
            await self.send_port_list(ws)
            return

        if msg_type == "sync":
            await self.send_json(ws, {"type": "nodes:update", "nodes": list(self.nodes.values())})
            await self.send_json(ws, self.get_settings_payload())
            await self.send_json(ws, self.get_node_locations_payload())
            return

        if msg_type in {"location:get", "LOCATION_GET"}:
            await self.send_json(ws, self.get_node_locations_payload())
            return

        if msg_type in {"location:set", "LOCATION_SET"}:
            node_id = data.get("nodeId")
            lat = data.get("lat")
            lng = data.get("lng")
            name = data.get("name")
            try:
                updated = await self.set_node_fixed_location(node_id, lat, lng, name)
            except ValueError as exc:
                await self.send_json(
                    ws,
                    {
                        "type": "STATUS",
                        "status": "error",
                        "message": str(exc),
                    },
                )
                return

            await self.send_json(ws, updated)
            await self.broadcast_json(updated)
            await self.broadcast_json(self.get_node_locations_payload())
            await self.broadcast_nodes()
            return

        if msg_type in {"location:clear", "LOCATION_CLEAR"}:
            node_id = data.get("nodeId")
            try:
                cleared = await self.clear_node_fixed_location(node_id)
            except ValueError as exc:
                await self.send_json(
                    ws,
                    {
                        "type": "STATUS",
                        "status": "error",
                        "message": str(exc),
                    },
                )
                return

            await self.send_json(ws, cleared)
            await self.broadcast_json(cleared)
            await self.broadcast_json(self.get_node_locations_payload())
            await self.broadcast_nodes()
            return

        if msg_type in {"settings:get", "SETTINGS_GET"}:
            await self.send_json(ws, self.get_settings_payload())
            return

        if msg_type in {"settings:set", "SETTINGS_SET"}:
            incoming_settings = data.get("settings")
            if not isinstance(incoming_settings, dict):
                await self.send_json(
                    ws,
                    {
                        "type": "STATUS",
                        "status": "error",
                        "message": "settings:set requires a 'settings' object",
                    },
                )
                return

            updated_payload = await self.apply_settings(incoming_settings)
            await self.send_json(ws, updated_payload)
            await self.broadcast_json(
                {
                    "type": "SETTINGS_UPDATED",
                    "settings": updated_payload.get("settings"),
                    "hardwareApply": updated_payload.get("hardwareApply"),
                }
            )
            return

        if msg_type in {"settings:reset", "SETTINGS_RESET"}:
            updated_payload = await self.apply_settings(self._copy_settings(DEFAULT_SETTINGS))
            await self.send_json(ws, updated_payload)
            await self.broadcast_json(
                {
                    "type": "SETTINGS_UPDATED",
                    "settings": updated_payload.get("settings"),
                    "hardwareApply": updated_payload.get("hardwareApply"),
                }
            )
            return

        if msg_type == "command":
            await self.handle_command(ws, data)
            return

        await self.send_json(
            ws,
            {
                "type": "STATUS",
                "status": "error",
                "message": f"Unsupported message type: {msg_type}",
            },
        )

    async def keep_alive_loop(self) -> None:
        while True:
            await self.disconnect_if_missing()
            connected = bool(self.conn.iface and self.conn.iface.isConnected.is_set())
            status_changed = self._recompute_node_statuses()
            status = "connected" if connected else "scanning"
            await self.broadcast_json(
                {
                    "type": "KEEP_ALIVE",
                    "status": status,
                    "port": self.conn.port_name,
                }
            )
            
            # Periodic node refresh to catch newly discovered nodes
            if connected and self.conn.iface:
                try:
                    old_count = len(self.nodes)
                    self._refresh_nodes_from_interface()
                    new_count = len(self.nodes)
                    now_ts = datetime.now(timezone.utc).timestamp()

                    if new_count != old_count:
                        logging.info(f"Node count changed: {old_count} -> {new_count}. Broadcasting update...")
                        await self.broadcast_nodes()
                    elif status_changed:
                        await self.broadcast_nodes()

                    now_ts = datetime.now(timezone.utc).timestamp()
                    timed_out_ids = [
                        packet_id
                        for packet_id, pending in self.pending_commands.items()
                        if (now_ts - float(pending.get("createdAt") or now_ts)) > ACK_TIMEOUT_SECONDS
                    ]
                    for packet_id in timed_out_ids:
                        pending = self.pending_commands.pop(packet_id, None)
                        if not pending:
                            continue

                        retried = await self._retry_pending_command(pending)
                        if retried:
                            await self.broadcast_command_delivery(retried)
                            continue

                        destination = str(pending.get("destination") or "").strip()
                        if destination and destination in self.nodes:
                            self.nodes[destination]["status"] = "offline"
                            self.nodes[destination]["lastUpdated"] = self._iso_from_timestamp(now_ts)
                            self.node_activity.pop(destination, None)

                        await self.broadcast_command_delivery(
                            {
                                **pending,
                                "status": "missed",
                                "errorReason": "ACK_TIMEOUT",
                                "resolvedAt": self._iso_from_timestamp(now_ts),
                            }
                        )

                    if timed_out_ids:
                        await self.broadcast_nodes()
                    elif status_changed:
                        await self.broadcast_nodes()
                except Exception as e:
                    logging.warning(f"Error during periodic node refresh: {e}")
            elif status_changed:
                await self.broadcast_nodes()
            
            await asyncio.sleep(2)

    async def auto_connect_loop(self) -> None:
        while True:
            await self.disconnect_if_missing()
            connected = bool(self.conn.iface and self.conn.iface.isConnected.is_set())
            if not connected:
                candidate = self.best_port()
                if candidate:
                    ok, _ = await self.connect_port(candidate)
                    if ok:
                        await self.send_connection_status("connected")
                        await self.broadcast_nodes()
                else:
                    await self.send_connection_status("scanning")
            await asyncio.sleep(3)

    async def websocket_handler(self, ws: WebSocketServerProtocol) -> None:
        self.clients.add(ws)
        try:
            await self.send_port_list(ws)
            await self.send_json(ws, self.get_settings_payload())
            await self.send_json(ws, self.get_node_locations_payload())
            await self.send_json(
                ws,
                {
                    "type": "KEEP_ALIVE",
                    "status": "connected" if (self.conn.iface and self.conn.iface.isConnected.is_set()) else "scanning",
                    "port": self.conn.port_name,
                },
            )
            await self.send_json(ws, {"type": "nodes:update", "nodes": list(self.nodes.values())})
            async for message in ws:
                await self.handle_message(ws, message)
        finally:
            self.clients.discard(ws)


async def main() -> None:
    gateway = MeshtasticGateway()
    gateway.loop = asyncio.get_running_loop()

    keep_alive_task = asyncio.create_task(gateway.keep_alive_loop())
    auto_connect_task = asyncio.create_task(gateway.auto_connect_loop())

    async with websockets.serve(gateway.websocket_handler, HOST, PORT, ping_interval=None):
        logging.info("Gateway WebSocket server started at ws://%s:%s", HOST, PORT)
        try:
            await asyncio.Future()
        finally:
            keep_alive_task.cancel()
            auto_connect_task.cancel()
            async with gateway.lock:
                await gateway._close_current_interface()
                gateway._unsubscribe_meshtastic_events()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info("Gateway stopped")
