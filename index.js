const express = require("express");
const cors = require("cors");
const axios = require("axios");
const mongoose = require("mongoose");

const app = express();
app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static("public"));

const API_KEY =
  process.env.OPENWEATHER_API_KEY || "a216f02f9004f6fedecea80b73fc8632";
const CITY = process.env.CITY || "Da Nang";

const http = axios.create({ timeout: 10000 });

// ================== Helpers ==================
function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseRangeMs(range) {
  const map = {
    "1h": 1 * 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
  };
  return map[String(range || "").toLowerCase()] || null;
}

function isDbConnected() {
  return mongoose.connection.readyState === 1; // 1 = connected
}

function isValidDate(d) {
  return d instanceof Date && !isNaN(d.getTime());
}

// ================== MongoDB: Schema + TTL 30 ngày ==================
const SensorReadingSchema = new mongoose.Schema(
  {
    stationId: { type: String, default: "station1", index: true },
    temperature: Number,
    humidity: Number,
    dustDensity: Number,
    co2Level: Number,
    rainStatus: Number,
    uvIndex: Number,
  },
  { timestamps: true }
);

// ✅ tự xoá sau 30 ngày
SensorReadingSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 30 }
);

// ✅ tối ưu query
SensorReadingSchema.index({ stationId: 1, createdAt: -1 });

const SensorReading = mongoose.model("SensorReading", SensorReadingSchema);

// ================== Rule lưu lịch sử: 1 phút/lần + biến động lớn ==================
let lastSavedAt = 0;
let lastSavedSnapshot = null;

// Ngưỡng “biến động lớn”
const THRESH = {
  temp: 0.8, // °C
  hum: 4, // %
  dust: 8, // µg/m³
  aqi: 20, // co2Level (bạn dùng như AQI)
  uv: 1.0, // UV
};

// có thể chỉnh bằng ENV nếu muốn
const HISTORY_MIN_INTERVAL_MS = toNum(
  process.env.HISTORY_MIN_INTERVAL_MS,
  60_000
);

let sensorData = {
  temperature: 0,
  humidity: 0,
  dustDensity: 0,
  co2Level: 0,
  rainStatus: 0,
  uvIndex: 0,
  lastUpdate: 0,
};

// ================== Tiny cache ==================
const cache = new Map();
async function withCache(key, ttlMs, fn) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts < ttlMs) return hit.data;
  const data = await fn();
  cache.set(key, { ts: now, data });
  return data;
}

// ================== Text helpers ==================
function uvText(uvi) {
  if (uvi <= 2) return "✅ An toàn";
  if (uvi <= 5) return "⚠️ Bình thường";
  if (uvi <= 7) return "⚠️ Cao";
  if (uvi <= 10) return "🚨 Rất cao";
  return "☠️ Cực nguy hiểm";
}

function owmAqiText(aqi1to5) {
  const map = {
    1: "✅ Tốt",
    2: "🟡 Khá",
    3: "⚠️ Trung bình",
    4: "🚨 Kém",
    5: "☠️ Rất xấu",
  };
  return map[aqi1to5] || "—";
}

// ================== ESP32 push ==================
app.post("/update-sensor", async (req, res) => {
  try {
    const b = req.body || {};

    const uvRaw =
      b.uvIndex ?? b.uv ?? b.uv_value ?? b.uvValue ?? sensorData.uvIndex ?? 0;

    sensorData = {
      temperature: toNum(b.temperature, sensorData.temperature || 0),
      humidity: toNum(b.humidity, sensorData.humidity || 0),
      dustDensity: toNum(b.dustDensity, sensorData.dustDensity || 0),
      co2Level: toNum(b.co2Level, sensorData.co2Level || 0),
      rainStatus: toNum(b.rainStatus, sensorData.rainStatus || 0),
      uvIndex: toNum(uvRaw, sensorData.uvIndex || 0),
      lastUpdate: Date.now(),
    };

    // ================== Lưu MongoDB theo rule ==================
    const now = Date.now();
    const dueByTime = now - lastSavedAt >= HISTORY_MIN_INTERVAL_MS;

    let dueBySpike = false;

    if (lastSavedSnapshot) {
      const dt = Math.abs(sensorData.temperature - lastSavedSnapshot.temperature);
      const dh = Math.abs(sensorData.humidity - lastSavedSnapshot.humidity);
      const dd = Math.abs(sensorData.dustDensity - lastSavedSnapshot.dustDensity);
      const da = Math.abs(sensorData.co2Level - lastSavedSnapshot.co2Level);
      const du = Math.abs(sensorData.uvIndex - lastSavedSnapshot.uvIndex);
      const rainChanged = sensorData.rainStatus !== lastSavedSnapshot.rainStatus;

      dueBySpike =
        rainChanged ||
        dt >= THRESH.temp ||
        dh >= THRESH.hum ||
        dd >= THRESH.dust ||
        da >= THRESH.aqi ||
        du >= THRESH.uv;
    } else {
      dueBySpike = true; // lần đầu có data → lưu luôn
    }

    if ((dueByTime || dueBySpike) && isDbConnected()) {
      const doc = {
        stationId: "station1",
        temperature: sensorData.temperature,
        humidity: sensorData.humidity,
        dustDensity: sensorData.dustDensity,
        co2Level: sensorData.co2Level,
        rainStatus: sensorData.rainStatus,
        uvIndex: sensorData.uvIndex,
      };

      try {
        await SensorReading.create(doc);
        lastSavedAt = now; // ✅ chỉ update khi save OK
        lastSavedSnapshot = { ...doc };
      } catch (err) {
        console.error("❌ Mongo save error:", err?.message || err);
      }
    }

    console.log("📡 ESP32:", sensorData);
    return res.sendStatus(200);
  } catch (e) {
    console.error("❌ update-sensor error:", e?.message || e);
    return res.sendStatus(500);
  }
});

// GET sensor + trạng thái online/offline chuẩn
app.get("/get-sensor", (req, res) => {
  const now = Date.now();
  const ageMs = now - (sensorData.lastUpdate || 0);
  const espOnline = !!sensorData.lastUpdate && ageMs <= 15000;
  res.json({ ...sensorData, espOnline, ageMs });
});

// ================== ✅ API LỊCH SỬ (CHỈNH THEO FRONTEND) ==================
// Frontend gọi: /api/history?stationId=station1&from=...&to=...&limit=...
// Frontend đọc: json.rows
app.get("/api/history", async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ ok: false, error: "MongoDB not connected" });
    }

    const stationId = req.query.stationId || "station1";
    const limit = Math.min(parseInt(req.query.limit || "200", 10), 3000);

    // ✅ mặc định ASC để chart vẽ đúng (cũ -> mới)
    const order = String(req.query.order || "asc").toLowerCase(); // asc|desc

    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    const rangeMs = parseRangeMs(req.query.range);

    const filter = { stationId };

    // ưu tiên from/to (vì frontend đang dùng)
    if (from || to) {
      const createdAt = {};
      if (from && isValidDate(from)) createdAt.$gte = from;
      if (to && isValidDate(to)) createdAt.$lte = to;
      if (Object.keys(createdAt).length) filter.createdAt = createdAt;
    } else if (rangeMs) {
      filter.createdAt = { $gte: new Date(Date.now() - rangeMs) };
    }

    const rows = await SensorReading.find(filter)
      .sort({ createdAt: order === "desc" ? -1 : 1 })
      .limit(limit)
      .lean();

    // ✅ trả rows để khớp frontend, giữ data để tương thích nếu code cũ có dùng
    res.json({ ok: true, rows, data: rows });
  } catch (err) {
    console.error("❌ history error:", err?.message || err);
    res.status(500).json({ ok: false, error: "history error" });
  }
});

// kiểm tra DB
app.get("/db-ping", (req, res) => {
  res.json({ ok: true, state: mongoose.connection.readyState });
});

// ================== OpenWeather fetchers ==================
async function fetchWeatherByCity(city) {
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
    city
  )}&units=metric&appid=${API_KEY}&lang=vi`;

  const r = await http.get(url);
  const d = r.data || {};
  return {
    name: d?.name || city,
    coord: { lat: d?.coord?.lat, lon: d?.coord?.lon },
    main: {
      temp: d?.main?.temp ?? null,
      humidity: d?.main?.humidity ?? null,
      pressure: d?.main?.pressure ?? null,
    },
    weather: {
      main: d?.weather?.[0]?.main ?? "Unknown",
      description: d?.weather?.[0]?.description ?? "",
    },
    wind: { speed: d?.wind?.speed ?? null },
    clouds: d?.clouds?.all ?? null,
    visibility: d?.visibility ?? null,
  };
}

async function fetchAirPollution(lat, lon) {
  const url = `https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${API_KEY}`;
  const r = await http.get(url);
  const item = r.data?.list?.[0];
  return {
    aqi: item?.main?.aqi ?? null,
    components: item?.components || null,
  };
}

// ================== UV from Open-Meteo (no key) ==================
async function fetchUvFromOpenMeteo(lat, lon) {
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=uv_index&timezone=Asia/Ho_Chi_Minh`;
  const r = await http.get(url);
  const uvi = r.data?.current?.uv_index;
  return typeof uvi === "number" ? uvi : null;
}

/**
 * GET /api/metrics?city=...
 * - AQI/PM: OpenWeather air_pollution
 * - UV: Open-Meteo uv_index
 */
app.get("/api/metrics", async (req, res) => {
  try {
    let city = req.query.city;
    let lat = req.query.lat;
    let lon = req.query.lon;

    let weather = null;

    if (city) {
      weather = await withCache(
        `weather:${city.toLowerCase()}`,
        2 * 60 * 1000,
        () => fetchWeatherByCity(city)
      );
      lat = weather?.coord?.lat;
      lon = weather?.coord?.lon;
    } else {
      lat = typeof lat === "string" ? Number(lat) : lat;
      lon = typeof lon === "string" ? Number(lon) : lon;
    }

    if (
      typeof lat !== "number" ||
      typeof lon !== "number" ||
      !isFinite(lat) ||
      !isFinite(lon)
    ) {
      return res.status(400).json({
        error: "Missing/invalid params. Use ?city=... or ?lat=...&lon=...",
      });
    }

    const air = await withCache(`air:${lat},${lon}`, 2 * 60 * 1000, () =>
      fetchAirPollution(lat, lon)
    );

    const uvi = await withCache(`uvmeteo:${lat},${lon}`, 5 * 60 * 1000, () =>
      fetchUvFromOpenMeteo(lat, lon)
    );

    return res.json({
      city: weather?.name || (city || null),
      coord: { lat, lon },

      weather: weather
        ? {
            temp: weather.main.temp,
            humidity: weather.main.humidity,
            pressure: weather.main.pressure,
            main: weather.weather.main,
            description: weather.weather.description,
            wind: weather.wind.speed,
            clouds: weather.clouds,
            visibility: weather.visibility,
          }
        : null,

      air: {
        aqi: air?.aqi ?? null,
        text: air?.aqi ? owmAqiText(air.aqi) : null,
        pm2_5: air?.components?.pm2_5 ?? null,
        pm10: air?.components?.pm10 ?? null,
      },

      uv: {
        uvi: uvi,
        text: typeof uvi === "number" ? uvText(uvi) : null,
      },
    });
  } catch (err) {
    console.error(err?.response?.data || err);
    return res.status(500).json({ error: "Metrics error" });
  }
});

// ================== Prediction giữ nguyên ==================
async function buildPrediction() {
  const ow = await http.get(
    `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
      CITY
    )}&units=metric&appid=${API_KEY}&lang=vi`
  );

  const tempOW = ow.data?.main?.temp ?? 0;
  const humOW = ow.data?.main?.humidity ?? 0;
  const owMain = ow.data?.weather?.[0]?.main ?? "Unknown";
  const owDesc = ow.data?.weather?.[0]?.description ?? "";

  const tempESP = sensorData.temperature ?? 0;
  const humESP = sensorData.humidity ?? 0;

  const accuracyTemp = calcAccuracyByTolerance(tempESP, tempOW, 3.0);
  const accuracyHum = calcAccuracyByTolerance(humESP, humOW, 15);

  const rainChance = calcRainChance(
    tempESP,
    humESP,
    sensorData.rainStatus,
    owMain
  );
  const recommendation = getRecommendation(tempESP, owMain, rainChance);

  return {
    espData: sensorData,
    openWeatherData: {
      temp: Math.round(tempOW),
      humidity: humOW,
      weather: owMain,
      description: owDesc,
    },
    comparison: { temperature: accuracyTemp, humidity: accuracyHum },
    predictionToday: {
      rainChance,
      recommendation,
      confidence: Math.round((accuracyTemp + accuracyHum) / 2),
    },
  };
}

app.get("/predict-station1", async (req, res) => {
  try {
    res.json(await buildPrediction());
  } catch (err) {
    console.error(err?.response?.data || err);
    res.status(500).json({ error: "OpenWeather error" });
  }
});

app.get("/forecast-ai", async (req, res) => {
  try {
    res.json(await buildPrediction());
  } catch (err) {
    console.error(err?.response?.data || err);
    res.status(500).json({ error: "Forecast AI error" });
  }
});

function calcAccuracyByTolerance(esp, ow, tol) {
  const diff = Math.abs((esp ?? 0) - (ow ?? 0));
  const score = 100 * Math.max(0, 1 - diff / tol);
  return Math.round(Math.min(100, score));
}

function calcRainChance(temp, hum, rainStatus, owMain) {
  if (rainStatus === 1) return 95;

  let chance = 0;
  if (hum > 85) chance += 45;
  else if (hum > 75) chance += 25;
  else if (hum > 65) chance += 10;

  if (owMain === "Rain" || owMain === "Thunderstorm") chance += 40;
  else if (owMain === "Clouds") chance += 15;

  if (temp < 24) chance += 10;

  return Math.min(100, chance);
}

function getRecommendation(temp, owMain, rainChance) {
  if (rainChance >= 80) return "☔ Khả năng mưa cao";
  if (temp >= 35) return "🔥 Nắng nóng";
  if (owMain === "Clear") return "☀️ Trời nắng";
  if (owMain === "Clouds") return "⛅ Nhiều mây";
  return "✅ Thời tiết ổn định";
}

// ================== Connect MongoDB trước khi listen ==================
async function start() {
  const PORT = process.env.PORT || 3000;

  if (!process.env.MONGO_URI) {
    console.warn("⚠️ MONGO_URI chưa set -> vẫn chạy web nhưng KHÔNG lưu lịch sử!");
  } else {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
    });
    console.log("✅ MongoDB connected!");
  }

  app.listen(PORT, "0.0.0.0", () =>
    console.log("running on http://localhost:" + PORT)
  );
}

start().catch((err) => {
  console.error("❌ Startup error:", err?.message || err);
  process.exit(1);
});
