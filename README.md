# UTE Weather Station

Hệ thống giám sát thời tiết và chất lượng không khí với ESP32.

## 🚀 Chạy với Docker

### Build image

```bash
docker build -t ute-weather .
```

### Run container

```bash
docker run -d -p 3000:3000 --name ute-weather ute-weather
```

### Run với biến môi trường

```bash
docker run -d -p 3000:3000 \
  -e OPENWEATHER_API_KEY=your_api_key \
  --name ute-weather ute-weather
```

### Docker Compose (tùy chọn)

```yaml
version: "3.8"
services:
  weather:
    build: .
    ports:
      - "3000:3000"
    environment:
      - OPENWEATHER_API_KEY=your_api_key
    restart: unless-stopped
```

## 💻 Chạy local

```bash
npm install
npm start
```

Truy cập: http://localhost:3000
