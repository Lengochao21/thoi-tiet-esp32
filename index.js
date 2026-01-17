const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static("public"));

const API_KEY =
  process.env.OPENWEATHER_API_KEY || "a216f02f9004f6fedecea80b73fc8632";
const CITY = process.env.CITY || "Da Nang";

const http = axios.create({ timeout: 10000 });

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
app.post("/update-sensor", (req, res) => {
  const b = req.body || {};

  // ✅ chịu nhiều key UV để khỏi kẹt nếu ESP gửi khác tên
  const uvRaw =
    b.uvIndex ?? b.uv ?? b.uv_value ?? b.uvValue ?? sensorData.uvIndex ?? 0;

  sensorData = {
    temperature: Number(b.temperature ?? sensorData.temperature ?? 0),
    humidity: Number(b.humidity ?? sensorData.humidity ?? 0),
    dustDensity: Number(b.dustDensity ?? sensorData.dustDensity ?? 0),
    co2Level: Number(b.co2Level ?? sensorData.co2Level ?? 0),
    rainStatus: Number(b.rainStatus ?? sensorData.rainStatus ?? 0),
    uvIndex: Number(uvRaw),
    lastUpdate: Date.now(),
  };

  console.log("📡 ESP32:", sensorData);
  res.sendStatus(200);
});

// GET sensor + trạng thái online/offline chuẩn
app.get("/get-sensor", (req, res) => {
  const now = Date.now();
  const ageMs = now - (sensorData.lastUpdate || 0);
  const espOnline = !!sensorData.lastUpdate && ageMs <= 15000;

  res.json({ ...sensorData, espOnline, ageMs });
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
    aqi: item?.main?.aqi ?? null, // 1..5
    components: item?.components || null, // pm2_5, pm10...
  };
}

// ================== ✅ UV from Open-Meteo (no key) ==================
async function fetchUvFromOpenMeteo(lat, lon) {
  // Air Quality API current uv_index
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=uv_index&timezone=Asia/Ho_Chi_Minh`;
  const r = await http.get(url);
  const uvi = r.data?.current?.uv_index;
  return typeof uvi === "number" ? uvi : null;
}

/**
 * GET /api/metrics?city=Da%20Nang
 * hoặc /api/metrics?lat=...&lon=...
 *
 * - AQI/PM: OpenWeather air_pollution (giữ nguyên)
 * - UV: Open-Meteo uv_index (không cần key)
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

    // ✅ AQI/PM: OpenWeather
    const air = await withCache(`air:${lat},${lon}`, 2 * 60 * 1000, () =>
      fetchAirPollution(lat, lon)
    );

    // ✅ UV: Open-Meteo (no key)
    const uvi = await withCache(`uvmeteo:${lat},${lon}`, 5 * 60 * 1000, () =>
      fetchUvFromOpenMeteo(lat, lon)
    );

    return res.json({
      city: weather?.name || (city || null),
      coord: { lat, lon },

      // trả thêm weather để frontend tiện dùng (không bắt buộc)
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
        aqi: air?.aqi ?? null, // 1..5
        text: air?.aqi ? owmAqiText(air.aqi) : null,
        pm2_5: air?.components?.pm2_5 ?? null,
        pm10: air?.components?.pm10 ?? null,
      },

      uv: {
        uvi: uvi, // number|null
        text: typeof uvi === "number" ? uvText(uvi) : null,
      },
    });
  } catch (err) {
    console.error(err?.response?.data || err);
    return res.status(500).json({ error: "Metrics error" });
  }
});

// ================== Prediction (station 1) giữ nguyên ==================
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log("running on http://localhost:" + PORT)
);
