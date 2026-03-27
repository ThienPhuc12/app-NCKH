Offline map tile setup for Leaflet

1) Put tile images in this folder with structure:
   /tiles/{z}/{x}/{y}.png

2) Enable offline mode by creating file app/.env with:
   REACT_APP_USE_OFFLINE_TILES=true

3) Optional websocket override:
   REACT_APP_GATEWAY_WS=ws://127.0.0.1:8765

4) Rebuild app after changing .env:
   npm run build

Tip:
- You can export tiles from QGIS, Mobile Atlas Creator, or MBTiles tools.
- Keep zoom levels practical (for example z=10..16) to limit storage.
