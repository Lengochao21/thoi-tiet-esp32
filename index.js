const express = require("express");
const cors = require("cors");
const axios = require("axios");
const mongoose = require("mongoose");
const webpush = require("web-push");

const app = express();
app.use(cors());
app.use(express.json({ limit: "300kb" })); // push sub hơi dài, tăng nhẹ
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
  return mongoose.connection.readyState === 1;
}
function isValidDate(d) {
  return d instanceof Date && !isNaN(d.getTime());
}

// ================== MongoDB: Sensor history schema (TTL 30 ngày) ==================
const SensorReadingSchema = new mongoose.Schema(
  {
    stationId: { type: String, default: "station1", index: true },
    temperature: Number,
    humidity: Number,
    dustDensity: Number, // PM2.5 (µg/m³)
    co2Level: Number, // bạn đang dùng như AQI (0-500)
    rainStatus: Number, // 0/1
    uvIndex: Number,
  },
  { timestamps: true }
);

SensorReadingSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 30 }
);
SensorReadingSchema.index({ stationId: 1, createdAt: -1 });

const SensorReading = mongoose.model("SensorReading", SensorReadingSchema);

// ================== Rule lưu lịch sử: 1 phút/lần + biến động lớn ==================
let lastSavedAt = 0;
let lastSavedSnapshot = null;

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

// ================== ✅ PUSH NOTIFICATION SETUP ==================
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:haongocle2131@gmail.com";

// lưu subscription: ưu tiên MongoDB, fallback memory
const memSubs = new Map(); // endpoint -> sub

const PushSubSchema = new mongoose.Schema(
  {
    endpoint: { type: String, unique: true, index: true },
    keys: {
      p256dh: String,
      auth: String,
    },
    createdAt: { type: Date, default: Date.now },
    userAgent: String,
  },
  { versionKey: false }
);
// tự dọn sau 180 ngày cho nhẹ DB
PushSubSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });

const PushSub = mongoose.model("PushSub", PushSubSchema);

function pushReady() {
  return !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);
}

function initWebPush() {
  if (!pushReady()) {
    console.warn("⚠️ Push: thiếu VAPID env (PUBLIC/PRIVATE/SUBJECT) -> không gửi thông báo!");
    return;
  }
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    console.log("✅ web-push vapid set OK");
  } catch (e) {
    console.error("❌ web-push setVapidDetails error:", e?.message || e);
  }
}

async function getAllSubs() {
  if (isDbConnected()) {
    const rows = await PushSub.find({}).lean();
    return rows.map((r) => ({ endpoint: r.endpoint, keys: r.keys }));
  }
  // memory
  return Array.from(memSubs.values());
}

async function saveSub(sub, userAgent = "") {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    throw new Error("Invalid subscription format");
  }
  if (isDbConnected()) {
    await PushSub.updateOne(
      { endpoint: sub.endpoint },
      {
        $set: {
          endpoint: sub.endpoint,
          keys: sub.keys,
          userAgent,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );
  } else {
    memSubs.set(sub.endpoint, sub);
  }
}

async function removeSub(endpoint) {
  if (!endpoint) return;
  if (isDbConnected()) {
    await PushSub.deleteOne({ endpoint });
  } else {
    memSubs.delete(endpoint);
  }
}

async function sendPushToAll(payloadObj) {
  if (!pushReady()) return { ok: false, error: "Push not configured" };

  const subs = await getAllSubs();
  if (!subs.length) return { ok: false, error: "No subscribers yet" };

  const payload = JSON.stringify(payloadObj);
  let okCount = 0;
  let failCount = 0;

  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      okCount++;
    } catch (e) {
      failCount++;
      const code = e?.statusCode;
      // 404/410: subscription chết -> xoá
      if (code === 404 || code === 410) {
        await removeSub(sub.endpoint);
      }
      console.error("❌ push send error:", code, e?.body || e?.message || e);
    }
  }

  return { ok: true, sent: okCount, failed: failCount };
}

// ========== PUSH ROUTES ==========
app.get("/api/push/vapidPublicKey", (req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(500).json({ ok: false, error: "Missing VAPID_PUBLIC_KEY" });
  res.json({ ok: true, publicKey: VAPID_PUBLIC_KEY });
});

app.post("/api/push/subscribe", async (req, res) => {
  try {
    if (!pushReady()) return res.status(500).json({ ok: false, error: "Push not configured" });

    const sub = req.body;
    const ua = req.headers["user-agent"] || "";
    await saveSub(sub, ua);

    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ subscribe error:", e?.message || e);
    return res.status(400).json({ ok: false, error: e?.message || "subscribe error" });
  }
});

// Test route: hỗ trợ BOTH GET và POST để khỏi “Cannot GET”
async function handlePushTest(req, res) {
  try {
    const result = await sendPushToAll({
      title: "✅ Test thông báo",
      body: "Nếu bạn thấy thông báo này thì chuông đã hoạt động!",
      url: "/", // click về trang chính
      ts: Date.now(),
    });
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (e) {
    console.error("❌ push test error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "push test error" });
  }
}
app.get("/api/push/test", handlePushTest);
app.post("/api/push/test", handlePushTest);

// ================== ✅ ALERT NGƯỠNG (tự gửi khi vượt) ==================
const ALERT_COOLDOWN_MS = toNum(process.env.ALERT_COOLDOWN_MS, 120000); // 2 phút / loại cảnh báo
const lastAlertAt = new Map(); // key -> ts

// Ngưỡng gợi ý (bạn có thể chỉnh lại)
const LIMITS = {
  TEMP_HIGH: toNum(process.env.LIMIT_TEMP_HIGH, 35),
  UV_HIGH: toNum(process.env.LIMIT_UV_HIGH, 8),
  PM25_HIGH: toNum(process.env.LIMIT_PM25_HIGH, 55.5), // theo bảng bạn gửi (xấu trở lên)
  AQI_HIGH: toNum(process.env.LIMIT_AQI_HIGH, 150), // 0-500 kiểu AQI
};

function canAlert(key, now) {
  const last = lastAlertAt.get(key) || 0;
  if (now - last < ALERT_COOLDOWN_MS) return false;
  lastAlertAt.set(key, now);
  return true;
}

function pm25Level(pm) {
  // bảng bạn gửi
  if (pm <= 12) return { text: "✅ Tốt", level: "good" };
  if (pm <= 35.4) return { text: "🟡 Trung bình", level: "moderate" };
  if (pm <= 55.4) return { text: "⚠️ Kém/Không tốt", level: "unhealthy_sg" };
  if (pm <= 150.4) return { text: "🚨 Không tốt cho sức khỏe", level: "unhealthy" };
  if (pm <= 250.4) return { text: "☠️ Rất không tốt", level: "very_unhealthy" };
  return { text: "☠️ Nguy hại", level: "hazardous" };
}

function aqiLevel(aqi) {
  // aqi kiểu 0-500 (ESP co2Level)
  if (aqi <= 50) return "✅ Tốt";
  if (aqi <= 100) return "🟡 Trung bình";
  if (aqi <= 150) return "⚠️ Kém/Không tốt";
  if (aqi <= 200) return "🚨 Không tốt cho sức khỏe";
  if (aqi <= 300) return "☠️ Rất không tốt";
  return "☠️ Nguy hại";
}

async function maybeSendAlerts(prev, cur) {
  if (!pushReady()) return;
  const now = Date.now();

  const t = Number(cur.temperature ?? 0);
  const u = Number(cur.uvIndex ?? 0);
  const pm = Number(cur.dustDensity ?? 0);
  const aqi = Number(cur.co2Level ?? 0);
  const rain = Number(cur.rainStatus ?? 0);

  // 1) Mưa: chỉ alert khi chuyển trạng thái
  if (prev && rain !== Number(prev.rainStatus ?? 0)) {
    if (canAlert("RAIN_CHANGE", now)) {
      await sendPushToAll({
        title: rain === 1 ? "🌧️ Phát hiện có mưa" : "☀️ Hết mưa",
        body: rain === 1 ? "Trạm 1 vừa phát hiện mưa." : "Trạm 1 ghi nhận đã hết mưa.",
        url: "/",
        type: "rain",
        ts: now,
      });
    }
  }

  // 2) Nhiệt độ cao
  if (t >= LIMITS.TEMP_HIGH && canAlert("TEMP_HIGH", now)) {
    await sendPushToAll({
      title: "🔥 Cảnh báo nhiệt độ cao",
      body: `Nhiệt độ hiện tại: ${t.toFixed(1)}°C (ngưỡng ${LIMITS.TEMP_HIGH}°C)`,
      url: "/",
      type: "temp",
      ts: now,
    });
  }

  // 3) UV cao
  if (u >= LIMITS.UV_HIGH && canAlert("UV_HIGH", now)) {
    await sendPushToAll({
      title: "☀️ Cảnh báo UV cao",
      body: `UV hiện tại: ${u.toFixed(1)} • ${uvText(u)} (ngưỡng ${LIMITS.UV_HIGH})`,
      url: "/",
      type: "uv",
      ts: now,
    });
  }

  // 4) PM2.5 cao
  if (pm >= LIMITS.PM25_HIGH && canAlert("PM25_HIGH", now)) {
    const lv = pm25Level(pm);
    await sendPushToAll({
      title: "🌫️ Cảnh báo bụi mịn PM2.5",
      body: `PM2.5: ${pm.toFixed(1)} µg/m³ • ${lv.text}`,
      url: "/",
      type: "pm25",
      ts: now,
    });
  }

  // 5) AQI cao (0-500)
  if (aqi >= LIMITS.AQI_HIGH && canAlert("AQI_HIGH", now)) {
    await sendPushToAll({
      title: "🌬️ Cảnh báo AQI cao",
      body: `AQI: ${Math.round(aqi)} • ${aqiLevel(aqi)} (ngưỡng ${LIMITS.AQI_HIGH})`,
      url: "/",
      type: "aqi",
      ts: now,
    });
  }
}

// ================== ESP32 push ==================
app.post("/update-sensor", async (req, res) => {
  try {
    const b = req.body || {};
    const prev = { ...sensorData }; // để detect change

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
      dueBySpike = true;
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
        lastSavedAt = now;
        lastSavedSnapshot = { ...doc };
      } catch (err) {
        console.error("❌ Mongo save error:", err?.message || err);
      }
    }

    // ✅ gửi cảnh báo nếu vượt ngưỡng
    maybeSendAlerts(prev, sensorData).catch((e) =>
      console.error("❌ alert error:", e?.message || e)
    );

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

    const order = String(req.query.order || "asc").toLowerCase();

    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    const rangeMs = parseRangeMs(req.query.range);

    const filter = { stationId };

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

// UV from Open-Meteo
async function fetchUvFromOpenMeteo(lat, lon) {
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=uv_index&timezone=Asia/Ho_Chi_Minh`;
  const r = await http.get(url);
  const uvi = r.data?.current?.uv_index;
  return typeof uvi === "number" ? uvi : null;
}

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

  // init web push (phải gọi trước)
  initWebPush();

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
