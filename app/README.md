# Web Dashboard NCKH - Frontend

Ung dung React cho he thong:
1. Ket noi gateway WebSocket
2. Quan ly canh bao BAODONG
3. Theo doi node realtime tren ban do

## Lenh su dung

### Chay development

```bash
npm start
```

Script nay se duoc goi qua file scripts/start-with-gateway.js.
Neu gateway da mo san o ws://127.0.0.1:8765, app se dung luon ket noi do.

### Build production

```bash
npm run build
```

### Test

```bash
npm test
```

## Bien moi truong tham khao

1. REACT_APP_GATEWAY_WS (mac dinh: ws://127.0.0.1:8765)
2. REACT_APP_USE_OFFLINE_TILES=true de dung tile offline trong public/tiles
