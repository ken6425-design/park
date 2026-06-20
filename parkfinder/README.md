# 停車雷達 ParkFinder

全台路外停車場「即時剩餘車位」+ OpenStreetMap 停車點，單一地圖、手機優先。
即時車位來自交通部 **TDX 運輸資料流通服務平臺**，需要一組免費金鑰。

## 你需要做的一件事：申請 TDX 金鑰（免費）

1. 到 https://tdx.transportdata.tw/ 註冊會員、完成 Email 驗證。
2. 登入後到「會員中心 → 資料服務 → API 金鑰」，編輯預設金鑰，記下 **Client Id** 與 **Client Secret**。
3. 把這兩組字串設成環境變數（見下）。沒設定也能跑，但只會顯示停車場位置、沒有即時車位。

## 本機執行

```bash
npm install
TDX_CLIENT_ID=你的id TDX_CLIENT_SECRET=你的secret npm start
# 開 http://localhost:3000
```
（定位需要 https 或 localhost；本機用 localhost 沒問題。）

## 部署到 Render

1. 把這個資料夾推到 GitHub。
2. Render → New → Blueprint，選這個 repo（會讀 `render.yaml`）。
3. 在 Environment 填入 `TDX_CLIENT_ID`、`TDX_CLIENT_SECRET`。
4. Deploy 完成即可。

## API

- `GET /api/parking/near?lat=&lng=&radius=` 就近回傳停車場（含即時車位）
- `GET /api/parking/city?city=Taipei` 整個縣市
- `GET /api/debug?city=Taipei` 回傳 TDX 原始第一筆，方便比對欄位
- `GET /api/health` 服務狀態（含金鑰是否設定）

## 資料說明

- 即時車位涵蓋以 TDX 有提供 ParkingAvailability 的縣市為主；沒有即時來源的停車場會標示「無即時」但仍顯示位置與總車位。
- 後端每縣市快取 30 秒、就近查最近 2 個縣市（自動涵蓋雙北交界）。
- 欄位採容錯解析（AvailableSpaces / AvailableCar 等），若某縣市欄位不同導致車位顯示異常，先打 `/api/debug?city=該縣市` 看原始欄位再對應。

資料來源：TDX 運輸資料流通服務平臺、OpenStreetMap、CARTO。
