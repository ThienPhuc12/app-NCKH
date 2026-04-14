# app-NCKH

Web dashboard giam sat va phat canh bao cho he thong LoRa Mesh.

## Chay nhanh

Tu thu muc goc du an:

```bash
npm --prefix app install
npm --prefix app start
```

Lenh start se:
1. Tu dong mo gateway Python tai engine/gateway.py (neu chua chay)
2. Mo React app (mac dinh cong 3000)

## Build production

```bash
npm --prefix app run build
```

## Loi thuong gap

### Cong 3000 dang ban

Neu thay thong bao "Something is already running on port 3000", hay:
1. Tat tien trinh dang dung cong 3000
2. Hoac chon yes de chay app o cong khac

### Khong ket noi duoc gateway

Kiem tra:
1. Tep engine/gateway.py ton tai
2. Python environment da duoc cai dat
3. Cong ws://127.0.0.1:8765 khong bi chan

