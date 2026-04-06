import asyncio
import json
import logging
import os
import re
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
OFFLINE_TIMEOUT_SECONDS = int(os.getenv("MESH_NODE_OFFLINE_TIMEOUT", "30"))
ACK_TIMEOUT_SECONDS = int(os.getenv("MESH_ACK_TIMEOUT", "18"))


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

        self._cb_node_updated = self._on_node_updated
        self._cb_connection_established = self._on_connection_established
        self._cb_connection_lost = self._on_connection_lost
        self._cb_receive = self._on_receive_packet

        self._load_firmware_board_signatures()

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

    def _load_firmware_board_signatures(self) -> None:
        boards_dir = Path(__file__).resolve().parent.parent / "firmware-develop" / "boards"
        if not boards_dir.exists():
            logging.info("Firmware board directory not found: %s", boards_dir)
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

    def _normalize_node(self, node: dict[str, Any]) -> Optional[dict[str, Any]]:
        node_num = node.get("num")
        user = node.get("user") or {}
        node_id = user.get("id")

        if not node_id and isinstance(node_num, int):
            node_id = f"!{node_num:08x}"

        if not node_id:
            return None

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

        metrics = node.get("deviceMetrics") or {}
        battery = self._safe_float(metrics.get("batteryLevel"))

        rssi = self._safe_float(node.get("rxRssi"))
        if rssi is None:
            rssi = self._safe_float(node.get("snr"))

        last_heard = self._safe_float(node.get("lastHeard"))
        now = datetime.now(timezone.utc).timestamp()
        status = "online"
        if last_heard is not None and now - last_heard > 600:
            status = "offline"

        local_num = self.conn.iface.myInfo.my_node_num if (self.conn.iface and self.conn.iface.myInfo) else None
        node_type = "gateway" if (local_num is not None and node_num == local_num) else "alarm"

        return {
            "id": node_id,
            "name": user.get("longName") or user.get("shortName") or node_id,
            "lat": lat,
            "lng": lng,
            "status": status,
            "type": node_type,
            "battery": battery,
            "rssi": rssi,
            "lastUpdated": self._iso_from_timestamp(last_heard),
            "raw": {
                "num": node_num,
                "shortName": user.get("shortName"),
                "hwModel": user.get("hwModel"),
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
        battery, rssi, rx_time = self._extract_packet_metrics(packet)
        text = self._extract_packet_text(packet)

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
            if not node_id or node_id == local_node_id or node_id in seen:
                continue
            seen.add(node_id)
            targets.append(node_id)

        # Fallback source: current normalized cache.
        for node_id in self.nodes.keys():
            if node_id == local_node_id or node_id in seen:
                continue
            seen.add(node_id)
            targets.append(node_id)

        return targets

    async def handle_command(self, ws: WebSocketServerProtocol, message: dict[str, Any]) -> None:
        request_id = message.get("requestId")
        text = (((message.get("payload") or {}).get("text")) or message.get("command") or "BAODONG").strip()
        target_id = (message.get("payload") or {}).get("targetId")
        destination = self._resolve_destination(target_id)

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
            else:
                destinations = [destination]

            results: list[dict[str, Any]] = []
            for dst in destinations:
                try:
                    sent_packet = await asyncio.to_thread(
                        iface.sendText,
                        text,
                        dst,
                        True,
                        True,
                    )
                except Exception as exc:
                    results.append(
                        {
                            "ok": False,
                            "destination": dst,
                            "destinationName": self._node_name_by_id(dst),
                            "error": str(exc),
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
                "sent": len(ok_results),
                "failed": len(results) - len(ok_results),
                "fanout": destination == BROADCAST_ADDR,
                "destinations": [
                    {
                        "id": item.get("destination"),
                        "name": item.get("destinationName"),
                        "packetId": item.get("packetId"),
                    }
                    for item in ok_results
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
                    stale_changed = False

                    now_ts = datetime.now(timezone.utc).timestamp()
                    for node in self.nodes.values():
                        seen_ts = self._timestamp_from_iso(node.get("lastUpdated"))
                        if seen_ts is None:
                            continue

                        age = now_ts - seen_ts
                        if age > OFFLINE_TIMEOUT_SECONDS and node.get("status") != "offline":
                            node["status"] = "offline"
                            stale_changed = True
                        elif age <= OFFLINE_TIMEOUT_SECONDS and node.get("status") != "online":
                            node["status"] = "online"
                            stale_changed = True

                    if new_count != old_count:
                        logging.info(f"Node count changed: {old_count} -> {new_count}. Broadcasting update...")
                        await self.broadcast_nodes()
                    elif stale_changed:
                        logging.info("Node stale status changed, broadcasting update")
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
                        await self.broadcast_command_delivery(
                            {
                                **pending,
                                "status": "missed",
                                "errorReason": "ACK_TIMEOUT",
                                "resolvedAt": self._iso_from_timestamp(now_ts),
                            }
                        )
                except Exception as e:
                    logging.warning(f"Error during periodic node refresh: {e}")
            
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
