// index.js (BACKEND FULL)
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const mongoose = require("mongoose");
const webpush = require("web-push");

const app = express();
app.use(cors());
app.use(express.json({ limit: "200kb" }));
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

// ================== MongoDB: Sensor Schema + TTL 30 ngày ==================
const SensorReadingSchema = new mongoose.Schema(
  {
    stationId: { type: String, default: "station1", index: true },
    temperature: Number,
    humidity: Number,
    dustDensity: Number, // PM2.5
    co2Level: Number, // bạn dùng như AQI (0..500)
    rainStatus: Number, // 0/1
    uvIndex: Number,
  },
  { timestamps: true }
);

// tự xoá sau 30 ngày
SensorReadingSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 30 }
);
SensorReadingSchema.index({ stationId: 1, createdAt: -1 });

const SensorReading = mongoose.model("SensorReading", SensorReadingSchema);

// ================== MongoDB: Push Subscription ==================
const PushSubSchema = new mongoose.Schema(
  {
    stationId: { type: String, default: "station1", index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userAgent: String,
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

PushSubSchema.index({ stationId: 1, updatedAt: -1 });
const PushSubscriptionModel = mongoose.model("PushSubscription", PushSubSchema);

// Fallback memory store nếu DB chưa kết nối (không khuyến khích, nhưng để chuông vẫn chạy)
const memSubs = new Map(); // endpoint -> {stationId, endpoint, keys, userAgent, enabled}

// ================== Rule lưu lịch sử: 1 phút/lần + biến động lớn ==================
let lastSavedAt = 0;
let lastSavedSnapshot = null;

// Ngưỡng “biến động lớn” (để lưu lịch sử)
const THRESH = {
  temp: 0.8,
  hum: 4,
  dust: 8,
  aqi: 20,
  uv: 1.0,
};

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

// AQI 0..500 (theo bảng bạn gửi)
function aqiText500(aqi) {
  if (aqi <= 50) return "✅ Tốt";
  if (aqi <= 100) return "🟡 Trung bình";
  if (aqi <= 150) return "⚠️ Kém/Không tốt";
  if (aqi <= 200) return "🚨 Không tốt cho SK";
  if (aqi <= 300) return "☠️ Rất không tốt";
  return "☠️ Nguy hại";
}

// PM2.5 theo thang (µg/m³)
function pm25Text(pm) {
  if (pm <= 12.0) return "✅ Tốt";
  if (pm <= 35.4) return "🟡 Trung bình";
  if (pm <= 55.4) return "⚠️ Kém/Không tốt";
  if (pm <= 150.4) return "🚨 Không tốt cho SK";
  if (pm <= 250.4) return "☠️ Rất không tốt";
  return "☠️ Nguy hại";
}

// ================== ✅ PUSH CONFIG (VAPID) ==================
// BẠN PHẢI SET ENV (khuyến khích):
// - VAPID_PUBLIC_KEY
// - VAPID_PRIVATE_KEY
// - VAPID_SUBJECT (vd: "mailto:haoln@ute.udn.vn" hoặc URL dự án)
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:example@example.com";

let pushReady = false;
function initWebPush() {
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    pushReady = true;
    console.log("✅ WebPush ready (VAPID loaded)");
  } else {
    pushReady = false;
    console.warn(
      "⚠️ WebPush chưa sẵn sàng: thiếu VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY"
    );
  }
}
initWebPush();

// ================== ✅ ALERT THRESHOLDS (cảnh báo) ==================
// Có thể chỉnh bằng ENV
const ALERT = {
  TEMP_HIGH: toNum(process.env.ALERT_TEMP_HIGH, 35), // °C
  UV_HIGH: toNum(process.env.ALERT_UV_HIGH, 8), // UV index
  AQI_HIGH: toNum(process.env.ALERT_AQI_HIGH, 150), // AQI 0..500
  PM25_HIGH: toNum(process.env.ALERT_PM25_HIGH, 55.5), // µg/m3
  // mưa: cảnh báo khi vừa chuyển từ 0 -> 1
};

// chống spam: mỗi loại cảnh báo có cooldown (ms)
const ALERT_COOLDOWN_MS = toNum(process.env.ALERT_COOLDOWN_MS, 5 * 60_000); // 5 phút
const lastAlertAt = new Map(); // key: stationId:type -> ts
const lastState = new Map(); // key: stationId -> {rainStatus, ...} để detect transition

function shouldSendAlert(stationId, type, nowTs) {
  const k = `${stationId}:${type}`;
  const last = lastAlertAt.get(k) || 0;
  if (nowTs - last < ALERT_COOLDOWN_MS) return false;
  lastAlertAt.set(k, nowTs);
  return true;
}

// ================== ✅ PUSH SENDERS ==================
async function getAllSubsByStation(stationId) {
  if (isDbConnected()) {
    const subs = await PushSubscriptionModel.find({ stationId, enabled: true })
      .lean()
      .limit(200);
    return subs.map((s) => ({
      stationId: s.stationId,
      endpoint: s.endpoint,
      keys: s.keys,
    }));
  }
  // fallback memory
  const arr = [];
  for (const s of memSubs.values()) {
    if (s.stationId === stationId && s.enabled) arr.push(s);
  }
  return arr;
}

async function removeSubByEndpoint(endpoint) {
  if (isDbConnected()) {
    await PushSubscriptionModel.deleteOne({ endpoint }).catch(() => {});
  }
  memSubs.delete(endpoint);
}

async function sendPushToStation(stationId, payload) {
  if (!pushReady) return { ok: false, error: "push_not_ready" };
  const subs = await getAllSubsByStation(stationId);
  if (!subs.length) return { ok: false, error: "no_subscribers" };

  const body = JSON.stringify(payload);
  let okCount = 0;

  for (const s of subs) {
    const subscription = {
      endpoint: s.endpoint,
      keys: s.keys,
    };

    try {
      await webpush.sendNotification(subscription, body, {
        TTL: 60,
      });
      okCount++;
    } catch (err) {
      const status = err?.statusCode;
      // 404/410: subscription invalid -> remove
      if (status === 404 || status === 410) {
        await removeSubByEndpoint(s.endpoint);
      }
      console.error("❌ push error:", status, err?.message || err);
    }
  }

  return { ok: true, sent: okCount };
}

function buildPushPayload({ title, body, level = "warn", data = {} }) {
  // level: info | warn | danger
  return {
    title,
    body,
    level,
    data,
    ts: Date.now(),
  };
}

async function checkAndSendAlertsForStation1() {
  const stationId = "station1";
  const now = Date.now();

  // only when recently updated (online)
  if (!sensorData.lastUpdate || now - sensorData.lastUpdate > 30_000) return;

  const t = toNum(sensorData.temperature, 0);
  const uv = toNum(sensorData.uvIndex, 0);
  const pm = toNum(sensorData.dustDensity, 0);
  const aqi = toNum(sensorData.co2Level, 0);
  const rain = toNum(sensorData.rainStatus, 0);

  const prev = lastState.get(stationId) || {};
  lastState.set(stationId, { rainStatus: rain });

  // 1) Rain started (0 -> 1)
  if (prev.rainStatus !== 1 && rain === 1) {
    if (shouldSendAlert(stationId, "RAIN_START", now)) {
      await sendPushToStation(
        stationId,
        buildPushPayload({
          title: "🌧️ Cảnh báo: Trời bắt đầu mưa",
          body: "Trạm 1 vừa phát hiện có mưa. Bạn nên kiểm tra khu vực.",
          level: "warn",
          data: { type: "RAIN_START", rainStatus: 1 },
        })
      );
    }
  }

  // 2) Temp high
  if (t >= ALERT.TEMP_HIGH) {
    if (shouldSendAlert(stationId, "TEMP_HIGH", now)) {
      await sendPushToStation(
        stationId,
        buildPushPayload({
          title: "🔥 Cảnh báo: Nhiệt độ cao",
          body: `Nhiệt độ hiện tại: ${t.toFixed(1)}°C (>= ${ALERT.TEMP_HIGH}°C).`,
          level: "danger",
          data: { type: "TEMP_HIGH", temperature: t },
        })
      );
    }
  }

  // 3) UV high
  if (uv >= ALERT.UV_HIGH) {
    if (shouldSendAlert(stationId, "UV_HIGH", now)) {
      await sendPushToStation(
        stationId,
        buildPushPayload({
          title: "☀️ Cảnh báo: UV cao",
          body: `UV hiện tại: ${uv.toFixed(1)} (${uvText(uv)}). Hạn chế ra nắng.`,
          level: "danger",
          data: { type: "UV_HIGH", uvIndex: uv },
        })
      );
    }
  }

  // 4) PM2.5 high
  if (pm >= ALERT.PM25_HIGH) {
    if (shouldSendAlert(stationId, "PM25_HIGH", now)) {
      await sendPushToStation(
        stationId,
        buildPushPayload({
          title: "💨 Cảnh báo: Bụi mịn PM2.5 cao",
          body: `PM2.5 hiện tại: ${pm.toFixed(1)} µg/m³ (${pm25Text(pm)}).`,
          level: "danger",
          data: { type: "PM25_HIGH", pm25: pm },
        })
      );
    }
  }

  // 5) AQI high (0..500)
  if (aqi >= ALERT.AQI_HIGH) {
    if (shouldSendAlert(stationId, "AQI_HIGH", now)) {
      await sendPushToStation(
        stationId,
        buildPushPayload({
          title: "🌬️ Cảnh báo: AQI cao",
          body: `AQI hiện tại: ${aqi.toFixed(0)} (${aqiText500(aqi)}).`,
          level: "danger",
          data: { type: "AQI_HIGH", aqi },
        })
      );
    }
  }
}

// ================== ✅ PUSH APIs ==================
app.get("/api/push/vapidPublicKey", (req, res) => {
  if (!VAPID_PUBLIC_KEY) {
    return res.status(503).json({
      ok: false,
      error: "VAPID_PUBLIC_KEY chưa set trên server",
    });
  }
  res.json({ ok: true, publicKey: VAPID_PUBLIC_KEY });
});

app.post("/api/push/subscribe", async (req, res) => {
  try {
    const stationId = req.body?.stationId || "station1";
    const sub = req.body?.subscription;
    const ua = req.headers["user-agent"] || "";

    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return res.status(400).json({ ok: false, error: "Invalid subscription" });
    }

    // save
    if (isDbConnected()) {
      await PushSubscriptionModel.updateOne(
        { endpoint: sub.endpoint },
        {
          $set: {
            stationId,
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.keys.p256dh,
              auth: sub.keys.auth,
            },
            userAgent: ua,
            enabled: true,
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
      );
    } else {
      memSubs.set(sub.endpoint, {
        stationId,
        endpoint: sub.endpoint,
        keys: sub.keys,
        userAgent: ua,
        enabled: true,
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ subscribe error:", err?.message || err);
    res.status(500).json({ ok: false, error: "subscribe error" });
  }
});

// (tuỳ chọn) test push từ browser: fetch('/api/push/test')
app.post("/api/push/test", async (req, res) => {
  try {
    const r = await sendPushToStation(
      "station1",
      buildPushPayload({
        title: "✅ Test thông báo",
        body: "Nếu bạn thấy thông báo này là chuông đã hoạt động!",
        level: "info",
        data: { type: "TEST" },
      })
    );
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: "test error" });
  }
});

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
        lastSavedAt = now; // chỉ update khi save OK
        lastSavedSnapshot = { ...doc };
      } catch (err) {
        console.error("❌ Mongo save error:", err?.message || err);
      }
    }

    // ✅ Check ngưỡng & gửi push cảnh báo
    // chạy async, không chặn response
    checkAndSendAlertsForStation1().catch(() => {});

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

// ================== ✅ API LỊCH SỬ ==================
app.get("/api/history", async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ ok: false, error: "MongoDB not connected" });
    }

    const stationId = req.query.stationId || "station1";
    const limit = Math.min(parseInt(req.query.limit || "200", 10), 3000);

    const order = String(req.query.order || "asc").toLowerCase(); // asc|desc

    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    const rangeMs = parseRangeMs(req.query.range);

    const filter = { stationId };

    // ưu tiên from/to
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
    console.warn("⚠️ MONGO_URI chưa set -> vẫn chạy web nhưng KHÔNG lưu lịch sử & subscription!");
  } else {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
    });
    console.log("✅ MongoDB connected!");
  }

  // re-init push when env present
  initWebPush();

  app.listen(PORT, "0.0.0.0", () =>
    console.log("running on http://localhost:" + PORT)
  );
}

start().catch((err) => {
  console.error("❌ Startup error:", err?.message || err);
  process.exit(1);
});
