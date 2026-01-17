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

const http = axios.create({
  timeout: 10000,
});

let sensorData = {
  temperature: 0,
  humidity: 0,
  dustDensity: 0,
  co2Level: 0, // ESP đang gửi AQI vào đây
  rainStatus: 0, // 1 = MƯA, 0 = KHÔ
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

// OpenWeather air_pollution main.aqi = 1..5
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
  sensorData = {
    temperature: Number(b.temperature ?? sensorData.temperature ?? 0),
    humidity: Number(b.humidity ?? sensorData.humidity ?? 0),
    dustDensity: Number(b.dustDensity ?? sensorData.dustDensity ?? 0),
    co2Level: Number(b.co2Level ?? sensorData.co2Level ?? 0),
    rainStatus: Number(b.rainStatus ?? sensorData.rainStatus ?? 0),
    uvIndex: Number(b.uvIndex ?? sensorData.uvIndex ?? 0),
    lastUpdate: Date.now(),
  };

  console.log("📡 ESP32:", sensorData);
  res.sendStatus(200);
});

// GET sensor + trạng thái online/offline chuẩn
app.get("/get-sensor", (req, res) => {
  const now = Date.now();
  const ageMs = now - (sensorData.lastUpdate || 0);
  const espOnline = !!sensorData.lastUpdate && ageMs <= 15000; // >15s coi như offline

  res.json({
    ...sensorData,
    espOnline,
    ageMs,
  });
});

// ================== OpenWeather fetchers ==================
async function fetchWeatherByCity(city) {
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
    city
  )}&units=metric&appid=${API_KEY}&lang=vi`;

  const r = await http.get(url);
  const d = r.data || {};

  const lat = d?.coord?.lat;
  const lon = d?.coord?.lon;

  return {
    name: d?.name || city,
    coord: { lat, lon },
    main: {
      temp: d?.main?.temp ?? null,
      humidity: d?.main?.humidity ?? null,
      pressure: d?.main?.pressure ?? null,
    },
    weather: {
      main: d?.weather?.[0]?.main ?? "Unknown",
      description: d?.weather?.[0]?.description ?? "",
    },
    wind: {
      speed: d?.wind?.speed ?? null,
    },
    clouds: d?.clouds?.all ?? null,
    visibility: d?.visibility ?? null,
  };
}

async function fetchAirPollution(lat, lon) {
  const url = `https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${API_KEY}`;
  const r = await http.get(url);
  const d = r.data || {};
  const item = d?.list?.[0];

  return {
    aqi: item?.main?.aqi ?? null, // 1..5
    components: item?.components || null, // pm2_5, pm10, co, no2, o3, so2, nh3...
  };
}

// One Call 3.0 (UVI) - có thể key bạn không có quyền => trả null
async function fetchUvi(lat, lon) {
  const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&exclude=minutely,hourly,daily,alerts&appid=${API_KEY}`;
  try {
    const r = await http.get(url);
    const uvi = r?.data?.current?.uvi;
    return typeof uvi === "number" ? uvi : null;
  } catch (e) {
    return null;
  }
}

// ================== NEW API: metrics for other locations ==================
/**
 * GET /api/metrics?city=Da%20Nang
 * hoặc /api/metrics?lat=16.07&lon=108.22
 *
 * Trả về: weather + air (aqi, pm2_5, pm10...) + uv (uvi nếu có)
 */
app.get("/api/metrics", async (req, res) => {
  try {
    let city = req.query.city;
    let lat = req.query.lat;
    let lon = req.query.lon;

    let weather = null;

    // Nếu có city -> lấy coord từ /weather
    if (city) {
      weather = await withCache(
        `weather:${city.toLowerCase()}`,
        2 * 60 * 1000,
        () => fetchWeatherByCity(city)
      );
      lat = weather?.coord?.lat;
      lon = weather?.coord?.lon;
    } else {
      // Nếu không có city thì phải có lat/lon
      lat = typeof lat === "string" ? Number(lat) : lat;
      lon = typeof lon === "string" ? Number(lon) : lon;
    }

    if (typeof lat !== "number" || typeof lon !== "number" || !isFinite(lat) || !isFinite(lon)) {
      return res.status(400).json({
        error: "Missing/invalid params. Use ?city=... or ?lat=...&lon=...",
      });
    }

    // Air + UV (cache nhẹ)
    const air = await withCache(`air:${lat},${lon}`, 2 * 60 * 1000, () =>
      fetchAirPollution(lat, lon)
    );

    const uvi = await withCache(`uvi:${lat},${lon}`, 5 * 60 * 1000, () =>
      fetchUvi(lat, lon)
    );

    // Nếu chưa fetch weather (trường hợp lat/lon) thì thôi, trả tối thiểu
    const out = {
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
        aqi: air?.aqi, // 1..5
        text: air?.aqi ? owmAqiText(air.aqi) : null,
        pm2_5: air?.components?.pm2_5 ?? null,
        pm10: air?.components?.pm10 ?? null,
        components: air?.components ?? null,
      },
      uv: {
        uvi: uvi, // number | null
        text: typeof uvi === "number" ? uvText(uvi) : null,
      },
    };

    return res.json(out);
  } catch (err) {
    console.error(err?.response?.data || err);
    return res.status(500).json({ error: "Metrics error" });
  }
});

// ================== Prediction (station 1) ==================
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

  const lat = ow.data?.coord?.lat;
  const lon = ow.data?.coord?.lon;

  // Lấy thêm AQI/PM của OpenWeather cho CITY (cache để đỡ spam)
  let owAir = { aqi: null, text: null, pm2_5: null, pm10: null };
  if (typeof lat === "number" && typeof lon === "number") {
    const air = await withCache(`air:${lat},${lon}`, 2 * 60 * 1000, () =>
      fetchAirPollution(lat, lon)
    );
    owAir = {
      aqi: air?.aqi ?? null,
      text: air?.aqi ? owmAqiText(air.aqi) : null,
      pm2_5: air?.components?.pm2_5 ?? null,
      pm10: air?.components?.pm10 ?? null,
    };
  }

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
      air: owAir, // ✅ thêm AQI/PM của OpenWeather
    },
    comparison: {
      temperature: accuracyTemp,
      humidity: accuracyHum,
    },
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

// Alias cho frontend cũ nếu còn gọi /forecast-ai
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
